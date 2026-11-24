/**
 * Game sounds, all synthesized live with the Web Audio API (no sound files).
 *
 * IMPORTANT: the "EAS" sound here is a deliberately FAKE sound-alike. The real
 * Emergency Alert System tones (the 853 + 960 Hz attention signal and the SAME
 * data bursts) must not be used outside real alerts, so we use different
 * pitches and made-up chirps that only give the same *feel*.
 */
export class AlertSounds {
  muted = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private easQueue: Array<{ speech: string; done: () => void }> = [];
  private easPlaying = false;
  private stopTimers: number[] = [];

  /** Browsers only allow sound after the player clicks or presses a key. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      /* no audio available: the game still works silently */
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.02);
    if (m && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  get busy(): boolean {
    return this.easPlaying;
  }

  /** A soft two-note blip for an incoming spotter report. */
  chime(): void {
    const c = this.ctx;
    if (!c || !this.master || this.muted || this.easPlaying) return;
    const t = c.currentTime;
    this.tone(880, t, 0.09, 0.12, 'sine');
    this.tone(1320, t + 0.1, 0.12, 0.12, 'sine');
  }

  /** Three quick beeps for a Severe Thunderstorm warning. */
  svrAlert(): void {
    const c = this.ctx;
    if (!c || !this.master || this.muted || this.easPlaying) return;
    const t = c.currentTime;
    for (let k = 0; k < 3; k++) this.tone(1000, t + k * 0.22, 0.14, 0.16, 'triangle');
  }

  /** A rising two-note "heads up" for a new watch, played twice. */
  watchAlert(): void {
    const c = this.ctx;
    if (!c || !this.master || this.muted || this.easPlaying) return;
    const t = c.currentTime;
    for (let k = 0; k < 2; k++) {
      this.tone(660, t + k * 0.5, 0.18, 0.14, 'sine');
      this.tone(990, t + k * 0.5 + 0.2, 0.25, 0.14, 'sine');
    }
  }

  /**
   * The full simulated EAS sequence: three digital chirp bursts, the two-tone
   * alarm, the voice reading the warning, then three short "end" bursts.
   * Calls `done` when finished (straight away-ish if muted or no audio).
   */
  eas(speech: string, done: () => void): void {
    this.easQueue.push({ speech, done });
    if (!this.easPlaying) this.nextEas();
  }

  private nextEas(): void {
    const job = this.easQueue.shift();
    if (!job) {
      this.easPlaying = false;
      return;
    }
    this.easPlaying = true;
    const finish = () => {
      job.done();
      this.nextEas();
    };
    const c = this.ctx;
    if (!c || !this.master || this.muted) {
      // Silent: still show the alert on screen for a while.
      this.after(9000, finish);
      return;
    }
    let t = c.currentTime + 0.1;
    for (let k = 0; k < 3; k++) {
      this.chirpBurst(t, 0.85);
      t += 1.35;
    }
    t += 0.4;
    // The two-tone alarm (NOT the real EAS pitches).
    this.tone(698, t, 3.5, 0.13, 'sine');
    this.tone(1047, t, 3.5, 0.13, 'sine');
    t += 3.8;
    const speechAt = (t - c.currentTime) * 1000;
    this.after(speechAt, () =>
      this.say(job.speech, () => {
        const c2 = this.ctx!;
        let t2 = c2.currentTime + 0.3;
        for (let k = 0; k < 3; k++) {
          this.chirpBurst(t2, 0.35);
          t2 += 0.8;
        }
        this.after((t2 - c2.currentTime) * 1000 + 300, finish);
      }),
    );
  }

  /** Read text aloud with the browser's built-in voice (if there is one). */
  private say(text: string, done: () => void): void {
    if (!('speechSynthesis' in window) || this.muted) {
      this.after(300, done);
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.0;
    u.pitch = 0.7;
    u.volume = 1;
    const voices = window.speechSynthesis.getVoices();
    const en = voices.find((v) => /en[-_]US/i.test(v.lang)) ?? voices.find((v) => /^en/i.test(v.lang));
    if (en) u.voice = en;
    let finished = false;
    const end = () => {
      if (finished) return;
      finished = true;
      done();
    };
    u.onend = end;
    u.onerror = end;
    // Safety net in case the voice never reports that it finished.
    this.after(Math.max(6000, text.length * 75), end);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  /** A made-up "digital data" chirp: random hops between two pitches. */
  private chirpBurst(start: number, dur: number): void {
    const c = this.ctx!;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'square';
    const step = 1 / 260;
    for (let t = 0; t < dur; t += step) osc.frequency.setValueAtTime(Math.random() < 0.5 ? 1250 : 1800, start + t);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.06, start + 0.01);
    g.gain.setValueAtTime(0.06, start + dur - 0.01);
    g.gain.linearRampToValueAtTime(0, start + dur);
    osc.connect(g).connect(this.master!);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  private tone(freq: number, start: number, dur: number, vol: number, type: OscillatorType): void {
    const c = this.ctx!;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.015);
    g.gain.setValueAtTime(vol, start + Math.max(0.02, dur - 0.03));
    g.gain.linearRampToValueAtTime(0, start + dur);
    osc.connect(g).connect(this.master!);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  private after(ms: number, fn: () => void): void {
    this.stopTimers.push(window.setTimeout(fn, ms));
  }
}
