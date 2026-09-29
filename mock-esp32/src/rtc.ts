/**
 * RtcLink — the tablet's UDP-like side channel (WebRTC data channel), one per WebSocket.
 *
 *   tablet ──ws: rtc_offer (full SDP)──►  RtcLink ──gathering complete──► ws: rtc_answer
 *   tablet ══data channel "state"══════►  onText(state JSON)  → the SAME session as the WebSocket
 *          ◄═════════════ pong ════════   (pings are answered on the channel, so the RTT is the UDP path's)
 *
 * The tablet opens the channel unordered with zero retransmits: a packet lost to
 * a Wi-Fi hiccup is simply gone, and the next one (10 ms later, fresher) takes
 * its place. The session already drops non-increasing seq, so reordering is safe.
 * Everything except state + ping stays on the WebSocket (reliable).
 */

import { PeerConnection, type DataChannel } from 'node-datachannel';
import { PROTOCOL_VERSION, encodeServer } from '@wheel/protocol';
import { log } from './log';

export class RtcLink {
  private pc: PeerConnection | null = null;
  private dc: DataChannel | null = null;
  private answered = false;
  /** Channel messages received — for the status line. */
  messages = 0;

  constructor(
    private readonly who: string,
    /** State JSON from the channel → the session (same socket identity as the WebSocket). */
    private readonly onText: (text: string) => void,
    /** Where to send the SDP answer (the WebSocket). */
    private readonly sendAnswer: (sdp: string) => void,
  ) {}

  get open(): boolean {
    return this.dc?.isOpen() === true;
  }

  handleOffer(sdp: string): void {
    this.close(); // a new offer replaces any old peer
    const pc = new PeerConnection(`bridge-${this.who}`, { iceServers: [] });
    this.pc = pc;
    this.answered = false;

    // No trickle: answer once gathering is complete, candidates embedded in the SDP.
    pc.onGatheringStateChange((state) => {
      if (state !== 'complete' || this.answered || this.pc !== pc) return;
      const local = pc.localDescription();
      if (!local) return;
      this.answered = true;
      this.sendAnswer(local.sdp);
    });
    pc.onStateChange((state) => {
      if (this.pc !== pc) return;
      if (state === 'failed' || state === 'closed' || state === 'disconnected') log('rtc', `${this.who} peer ${state}`);
    });
    pc.onDataChannel((dc) => {
      if (this.pc !== pc) return dc.close();
      this.dc = dc;
      log('rtc', `${this.who} data channel open ("${dc.getLabel()}") — state + ping now over UDP`);
      dc.onMessage((msg) => {
        const text = typeof msg === 'string' ? msg : msg.toString();
        this.messages++;
        if (text.includes('"type":"ping"')) return this.pong(dc, text);
        this.onText(text);
      });
      dc.onClosed(() => {
        if (this.dc === dc) {
          this.dc = null;
          log('rtc', `${this.who} data channel closed — the tablet falls back to the WebSocket`);
        }
      });
    });
    pc.setRemoteDescription(sdp, 'offer');
  }

  close(): void {
    try {
      this.dc?.close();
      this.pc?.close();
    } catch {
      /* already closed */
    }
    this.dc = null;
    this.pc = null;
  }

  /** Answer a ping on the channel it came in on. */
  private pong(dc: DataChannel, text: string): void {
    try {
      const m = JSON.parse(text) as { id?: unknown; timestamp?: unknown };
      if (typeof m.id !== 'number' || typeof m.timestamp !== 'number') return;
      dc.sendMessage(
        encodeServer({
          type: 'pong',
          version: PROTOCOL_VERSION,
          id: m.id,
          clientTimestamp: m.timestamp,
          serverTimestamp: performance.now(),
        }),
      );
    } catch {
      /* malformed ping: ignore */
    }
  }
}
