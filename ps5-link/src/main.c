// ps5-link — a headless PS5 Remote Play client that ONLY sends controller input.
//
//   Mac bridge ──stdin: "P lx ly rx ry l2 r2 hat btn\n"──► ps5-link ──Remote Play (libchiaki)──► PS5 ──HDMI──► TV
//
// Audio and video are disabled: chiaki asks for the smallest stream and drops
// those packets on arrival, so there's no window and no decoding. Watch the TV.
// The line format is the same one the ESP32 pad_bridge firmware takes (the
// Mac bridge's mapping is reused as-is): sticks 0..255 (128 = centre),
// triggers 0..255, hat 0..7 (N, NE … NW) / 8 = released, btn = DualSense bit mask.
//
// Commands:
//   ps5-link register --host <ps5-ip> --pin <8 digits> --account-id <base64> [--creds <file>]
//        one-time pairing. PIN: PS5 → Settings → System → Remote Play → Link Device.
//        Account ID: third_party/chiaki-ng/scripts/psn-account-id.py
//   ps5-link run [--creds <file>] [--host <ps5-ip>] [--wake] [--login-pin <4 digits>]
//        connect and forward stdin. Prints "READY" on stdout once connected,
//        "QUIT <reason>" before exiting. Everything else goes to stderr.
//
// Input is sent on CHANGE only: the bridge writes a line when the state changes,
// never repeats one, and a state holds until the next line. Nothing here may
// repeat an input to the PS5 either — every chiaki history packet re-carries the
// last few button events, and the PS5 takes those as fresh presses (a repeated
// trigger packet made one D-pad tap scroll the menu several times).
//
// SAFETY: stdin closed (the bridge died) → idle and disconnect. The bridge
// itself sends one neutral line when the tablet goes quiet or disarms.

#include <chiaki/base64.h>
#include <chiaki/controller.h>
#include <chiaki/discovery.h>
#include <chiaki/log.h>
#include <chiaki/regist.h>
#include <chiaki/session.h>

#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define DEFAULT_CREDS "ps5-link.creds"

// ─── small helpers ────────────────────────────────────────────────────────────

static void die(const char *fmt, ...) {
	va_list ap;
	va_start(ap, fmt);
	fprintf(stderr, "ps5-link: ");
	vfprintf(stderr, fmt, ap);
	fprintf(stderr, "\n");
	va_end(ap);
	exit(2);
}

static const char *arg_value(int argc, char **argv, const char *name) {
	for (int i = 0; i + 1 < argc; i++)
		if (strcmp(argv[i], name) == 0) return argv[i + 1];
	return NULL;
}

static bool arg_flag(int argc, char **argv, const char *name) {
	for (int i = 0; i < argc; i++)
		if (strcmp(argv[i], name) == 0) return true;
	return false;
}

static void hex_encode(const uint8_t *in, size_t n, char *out) {
	for (size_t i = 0; i < n; i++) sprintf(out + 2 * i, "%02x", in[i]);
}

static bool hex_decode(const char *in, uint8_t *out, size_t n) {
	if (strlen(in) != 2 * n) return false;
	for (size_t i = 0; i < n; i++) {
		unsigned v;
		if (sscanf(in + 2 * i, "%2x", &v) != 1) return false;
		out[i] = (uint8_t)v;
	}
	return true;
}

static void log_cb(ChiakiLogLevel level, const char *msg, void *user) {
	(void)user;
	fprintf(stderr, "[chiaki %c] %s\n", chiaki_log_level_char(level), msg);
}

// ─── credentials file (key=value, what pairing gives us) ─────────────────────

typedef struct {
	char host[256];
	char regist_key[CHIAKI_SESSION_AUTH_SIZE]; // raw, NUL-padded
	uint8_t morning[0x10];
	char nickname[0x20];
} Creds;

static void creds_save(const char *path, const Creds *c) {
	FILE *f = fopen(path, "w");
	if (!f) die("can't write %s: %s", path, strerror(errno));
	char rk[2 * CHIAKI_SESSION_AUTH_SIZE + 1], mo[2 * 0x10 + 1];
	hex_encode((const uint8_t *)c->regist_key, sizeof c->regist_key, rk);
	hex_encode(c->morning, sizeof c->morning, mo);
	fprintf(f, "# ps5-link pairing — keep private (it lets this Mac start Remote Play on your PS5)\n");
	fprintf(f, "host=%s\nnickname=%s\nregist_key=%s\nmorning=%s\n", c->host, c->nickname, rk, mo);
	fclose(f);
	chmod(path, 0600);
}

static void creds_load(const char *path, Creds *c) {
	FILE *f = fopen(path, "r");
	if (!f) die("no pairing file %s — run `ps5-link register` first", path);
	memset(c, 0, sizeof *c);
	char line[512];
	bool rk = false, mo = false;
	while (fgets(line, sizeof line, f)) {
		line[strcspn(line, "\r\n")] = 0;
		char *eq = strchr(line, '=');
		if (line[0] == '#' || !eq) continue;
		*eq = 0;
		const char *k = line, *v = eq + 1;
		if (!strcmp(k, "host")) snprintf(c->host, sizeof c->host, "%s", v);
		else if (!strcmp(k, "nickname")) snprintf(c->nickname, sizeof c->nickname, "%s", v);
		else if (!strcmp(k, "regist_key")) rk = hex_decode(v, (uint8_t *)c->regist_key, sizeof c->regist_key);
		else if (!strcmp(k, "morning")) mo = hex_decode(v, c->morning, sizeof c->morning);
	}
	fclose(f);
	if (!rk || !mo) die("pairing file %s is incomplete — run `ps5-link register` again", path);
}

// ─── register ────────────────────────────────────────────────────────────────

typedef struct {
	pthread_mutex_t mu;
	pthread_cond_t cond;
	bool done;
	bool ok;
	ChiakiRegisteredHost host;
} RegistWait;

static void regist_cb(ChiakiRegistEvent *event, void *user) {
	RegistWait *w = user;
	pthread_mutex_lock(&w->mu);
	w->ok = event->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_SUCCESS;
	if (w->ok) w->host = *event->registered_host;
	w->done = true;
	pthread_cond_signal(&w->cond);
	pthread_mutex_unlock(&w->mu);
}

static int cmd_register(int argc, char **argv, ChiakiLog *log) {
	const char *host = arg_value(argc, argv, "--host");
	const char *pin = arg_value(argc, argv, "--pin");
	const char *account = arg_value(argc, argv, "--account-id");
	const char *path = arg_value(argc, argv, "--creds");
	if (!path) path = DEFAULT_CREDS;
	if (!host || !pin || !account) die("register needs --host, --pin and --account-id");

	ChiakiRegistInfo info = {0};
	info.target = CHIAKI_TARGET_PS5_1;
	info.host = host;
	info.broadcast = false;
	info.pin = (uint32_t)strtoul(pin, NULL, 10);
	size_t n = sizeof info.psn_account_id;
	if (chiaki_base64_decode(account, strlen(account), info.psn_account_id, &n) != CHIAKI_ERR_SUCCESS ||
	    n != CHIAKI_PSN_ACCOUNT_ID_SIZE)
		die("--account-id must be the base64 PSN account id (%d bytes)", CHIAKI_PSN_ACCOUNT_ID_SIZE);

	RegistWait w = {.mu = PTHREAD_MUTEX_INITIALIZER, .cond = PTHREAD_COND_INITIALIZER};
	ChiakiRegist regist;
	if (chiaki_regist_start(&regist, log, &info, regist_cb, &w) != CHIAKI_ERR_SUCCESS) die("couldn't start pairing");
	pthread_mutex_lock(&w.mu);
	while (!w.done) pthread_cond_wait(&w.cond, &w.mu);
	pthread_mutex_unlock(&w.mu);
	chiaki_regist_fini(&regist);
	if (!w.ok) die("pairing failed — check the PIN (it expires after a few minutes) and the account id");

	Creds c = {0};
	snprintf(c.host, sizeof c.host, "%s", host);
	memcpy(c.regist_key, w.host.rp_regist_key, sizeof c.regist_key);
	memcpy(c.morning, w.host.rp_key, sizeof c.morning);
	memcpy(c.nickname, w.host.server_nickname, sizeof c.nickname - 1);
	creds_save(path, &c);
	fprintf(stderr, "ps5-link: paired with \"%s\" (%s) → %s\n", c.nickname, host, path);
	return 0;
}

// ─── run ─────────────────────────────────────────────────────────────────────

static volatile sig_atomic_t stop_requested = 0;
static void on_signal(int sig) {
	(void)sig;
	stop_requested = 1;
}

typedef struct {
	ChiakiSession *session;
	const char *login_pin;
	volatile bool connected;
	volatile bool quit;
} RunState;

static void event_cb(ChiakiEvent *event, void *user) {
	RunState *r = user;
	switch (event->type) {
		case CHIAKI_EVENT_CONNECTED:
			r->connected = true;
			printf("READY\n");
			fflush(stdout);
			break;
		case CHIAKI_EVENT_LOGIN_PIN_REQUEST:
			if (r->login_pin && !event->login_pin_request.pin_incorrect) {
				chiaki_session_set_login_pin(r->session, (const uint8_t *)r->login_pin, strlen(r->login_pin));
			} else {
				fprintf(stderr, "ps5-link: the PS5 asks for its login PIN — pass --login-pin\n");
				chiaki_session_stop(r->session);
			}
			break;
		case CHIAKI_EVENT_QUIT:
			printf("QUIT %s\n", chiaki_quit_reason_string(event->quit.reason));
			fflush(stdout);
			r->quit = true;
			break;
		default:
			break;
	}
}

/** DualSense report bits (pad_bridge / padBridge.ts DS_BUTTONS) → chiaki buttons. */
static uint32_t map_buttons(unsigned long ds, unsigned hat) {
	static const struct { unsigned long ds; uint32_t chiaki; } M[] = {
		{1ul << 4, CHIAKI_CONTROLLER_BUTTON_BOX},     {1ul << 5, CHIAKI_CONTROLLER_BUTTON_CROSS},
		{1ul << 6, CHIAKI_CONTROLLER_BUTTON_MOON},    {1ul << 7, CHIAKI_CONTROLLER_BUTTON_PYRAMID},
		{1ul << 8, CHIAKI_CONTROLLER_BUTTON_L1},      {1ul << 9, CHIAKI_CONTROLLER_BUTTON_R1},
		{1ul << 12, CHIAKI_CONTROLLER_BUTTON_SHARE},  {1ul << 13, CHIAKI_CONTROLLER_BUTTON_OPTIONS},
		{1ul << 14, CHIAKI_CONTROLLER_BUTTON_L3},     {1ul << 15, CHIAKI_CONTROLLER_BUTTON_R3},
		{1ul << 16, CHIAKI_CONTROLLER_BUTTON_PS},     {1ul << 17, CHIAKI_CONTROLLER_BUTTON_TOUCHPAD},
	};
	uint32_t b = 0;
	for (size_t i = 0; i < sizeof M / sizeof M[0]; i++)
		if (ds & M[i].ds) b |= M[i].chiaki;
	// hat 0 = N … 7 = NW, 8 = released
	static const uint32_t H[8] = {
		CHIAKI_CONTROLLER_BUTTON_DPAD_UP,
		CHIAKI_CONTROLLER_BUTTON_DPAD_UP | CHIAKI_CONTROLLER_BUTTON_DPAD_RIGHT,
		CHIAKI_CONTROLLER_BUTTON_DPAD_RIGHT,
		CHIAKI_CONTROLLER_BUTTON_DPAD_DOWN | CHIAKI_CONTROLLER_BUTTON_DPAD_RIGHT,
		CHIAKI_CONTROLLER_BUTTON_DPAD_DOWN,
		CHIAKI_CONTROLLER_BUTTON_DPAD_DOWN | CHIAKI_CONTROLLER_BUTTON_DPAD_LEFT,
		CHIAKI_CONTROLLER_BUTTON_DPAD_LEFT,
		CHIAKI_CONTROLLER_BUTTON_DPAD_UP | CHIAKI_CONTROLLER_BUTTON_DPAD_LEFT,
	};
	if (hat < 8) b |= H[hat];
	return b;
}

/** 0..255 (128 = centre) → chiaki's int16 axis. */
static int16_t axis(unsigned v) {
	long a = ((long)v - 128) * 258;
	if (a > 32767) a = 32767;
	if (a < -32768) a = -32768;
	return (int16_t)a;
}

/** "P lx ly rx ry l2 r2 hat btn" → state. false = malformed / out of range (ignored). */
static bool parse_line(const char *line, ChiakiControllerState *s) {
	unsigned v[7];
	unsigned long btn;
	if (sscanf(line, "P %u %u %u %u %u %u %u %lu", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6], &btn) != 8)
		return false;
	for (int i = 0; i < 6; i++)
		if (v[i] > 255) return false;
	if (v[6] > 8) return false;
	chiaki_controller_state_set_idle(s);
	s->left_x = axis(v[0]);
	s->left_y = axis(v[1]);
	s->right_x = axis(v[2]);
	s->right_y = axis(v[3]);
	s->l2_state = (uint8_t)v[4];
	s->r2_state = (uint8_t)v[5];
	s->buttons = map_buttons(btn, v[6]);
	return true;
}

static int cmd_run(int argc, char **argv, ChiakiLog *log) {
	const char *path = arg_value(argc, argv, "--creds");
	if (!path) path = DEFAULT_CREDS;
	Creds c;
	creds_load(path, &c);
	const char *host = arg_value(argc, argv, "--host");
	if (!host) host = c.host;

	if (arg_flag(argc, argv, "--wake")) {
		// The wake-up credential is the regist key read as a hex number.
		char rk[CHIAKI_SESSION_AUTH_SIZE + 1] = {0};
		memcpy(rk, c.regist_key, CHIAKI_SESSION_AUTH_SIZE);
		uint64_t cred = strtoull(rk, NULL, 16);
		ChiakiErrorCode err = chiaki_discovery_wakeup(log, NULL, host, cred, true);
		fprintf(stderr, "ps5-link: wake-up sent to %s (%s) — give it ~20 s\n", host, chiaki_error_string(err));
		sleep(20);
	}

	ChiakiConnectInfo ci = {0};
	ci.ps5 = true;
	ci.host = host;
	memcpy(ci.regist_key, c.regist_key, sizeof ci.regist_key);
	memcpy(ci.morning, c.morning, sizeof ci.morning);
	chiaki_connect_video_profile_preset(&ci.video_profile, CHIAKI_VIDEO_RESOLUTION_PRESET_360p, CHIAKI_VIDEO_FPS_PRESET_30);
	ci.video_profile_auto_downgrade = true;
	ci.audio_video_disabled = CHIAKI_AUDIO_DISABLED | CHIAKI_VIDEO_DISABLED; // input only: watch the TV
	ci.enable_keyboard = false;
	ci.enable_dualsense = true;
	ci.packet_loss_max = 0.05; // chiaki-ng's default

	ChiakiSession session;
	if (chiaki_session_init(&session, &ci, log) != CHIAKI_ERR_SUCCESS) die("couldn't init session");
	RunState r = {.session = &session, .login_pin = arg_value(argc, argv, "--login-pin")};
	chiaki_session_set_event_cb(&session, event_cb, &r);
	if (chiaki_session_start(&session) != CHIAKI_ERR_SUCCESS) die("couldn't start session");
	fprintf(stderr, "ps5-link: connecting to %s (%s), audio/video off…\n", host, c.nickname);

	ChiakiControllerState state;
	chiaki_controller_state_set_idle(&state);
	char buf[256];
	size_t len = 0;

	while (!stop_requested && !r.quit) {
		struct pollfd p = {.fd = STDIN_FILENO, .events = POLLIN};
		int ready = poll(&p, 1, 100); // wakes only to notice stop / quit
		if (ready > 0) {
			ssize_t got = read(STDIN_FILENO, buf + len, sizeof buf - 1 - len);
			if (got <= 0) {
				fprintf(stderr, "ps5-link: stdin closed — idling and disconnecting\n");
				break;
			}
			len += (size_t)got;
			buf[len] = 0;
			char *nl;
			while ((nl = strchr(buf, '\n'))) {
				*nl = 0;
				if (parse_line(buf, &state)) {
					chiaki_session_set_controller_state(&session, &state);
				}
				size_t rest = len - (size_t)(nl + 1 - buf);
				memmove(buf, nl + 1, rest);
				len = rest;
				buf[len] = 0;
			}
			if (len >= sizeof buf - 1) len = 0; // runaway line: drop it
		}
	}

	chiaki_controller_state_set_idle(&state);
	chiaki_session_set_controller_state(&session, &state);
	chiaki_session_stop(&session);
	chiaki_session_join(&session);
	chiaki_session_fini(&session);
	return r.quit ? 1 : 0;
}

int main(int argc, char **argv) {
	setvbuf(stdout, NULL, _IOLBF, 0);
	signal(SIGINT, on_signal);
	signal(SIGTERM, on_signal);
	signal(SIGPIPE, SIG_IGN);

	ChiakiLog log;
	chiaki_log_init(&log, arg_flag(argc, argv, "--verbose") ? CHIAKI_LOG_ALL : (CHIAKI_LOG_ALL & ~CHIAKI_LOG_VERBOSE & ~CHIAKI_LOG_DEBUG),
	                log_cb, NULL);

	if (argc >= 2 && !strcmp(argv[1], "register")) return cmd_register(argc, argv, &log);
	if (argc >= 2 && !strcmp(argv[1], "run")) return cmd_run(argc, argv, &log);
	fprintf(stderr,
	        "usage:\n"
	        "  ps5-link register --host <ps5-ip> --pin <8 digits> --account-id <base64> [--creds <file>]\n"
	        "  ps5-link run [--creds <file>] [--host <ps5-ip>] [--wake] [--login-pin <pin>] [--verbose]\n");
	return 2;
}
