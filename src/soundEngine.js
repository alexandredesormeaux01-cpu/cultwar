/* ==========================================================================
   Cult War — Sound Engine (SFX + musique de partie)
   ========================================================================== */

/* Chemins relatifs à BASE_URL (vite `base: './'`) : obligatoire sur GitHub Pages
   (/cultwar/) et Capacitor — un chemin absolu `/assets/...` renvoie 404. */
/* Chaînage optionnel volontaire : hors bundler (tests Node), import.meta.env
   n'existe pas et lire .BASE_URL dessus lèverait une TypeError au chargement
   même du module. */
const asset = (file) => `${import.meta.env?.BASE_URL ?? './'}assets/${file}`;

const SFX = {
  convert: asset('sfx_convert.mp3'),
  ui_click: asset('sfx_click.mp3'),
  defeat: asset('sfx_defeat.mp3'),
  disciple: asset('sfx_disciple.mp3'),
  disciple_alien: asset('sfx_disciple_alien.mp3'),
  bell: asset('sfx_bell.mp3'),
  crystal: asset('sfx_crystal_explode.mp3'),
  paint_orb: asset('sfx_paint_orb.mp3'),

  fire_1: asset('sfx_fire_1.mp3'),
  fire_2: asset('sfx_fire_2.mp3'),
  fire_3: asset('sfx_fire_3.mp3'),
  fire_4: asset('sfx_fire_4.mp3'),
  fire_5: asset('sfx_fire_5.mp3'),
  fire_6: asset('sfx_fire_6.mp3'),

  earth_1: asset('sfx_earth_1.mp3'),
  earth_2: asset('sfx_earth_2.mp3'),
  earth_3: asset('sfx_earth_3.mp3'),
};

/* Familles de variantes. Un tir part toutes les 0,85 s : un son unique
   deviendrait vite une scie. On tire au hasard dans la famille, en excluant la
   dernière jouée — sur six variantes, le hasard pur redonne la même deux fois
   de suite une fois sur six, et l'oreille l'entend immédiatement. */
const SFX_GROUPS = {
  fire: ['fire_1', 'fire_2', 'fire_3', 'fire_4', 'fire_5', 'fire_6'],
  earth: ['earth_1', 'earth_2', 'earth_3'],
};

const MUSIC = {
  match: asset('music_pocket_quest.mp3'),
  pulse: asset('music_pocket_quest_pulse.mp3'),
};

const MUSIC_VOL = 0.38;
const SFX_VOL = 0.75;
const MUSIC_XFADE = 1.4; // secondes pour passer base ↔ pulse

class SoundEngine {
  constructor() {
    this.isMuted = false;
    this._unlocked = false;
    this._pool = new Map();
    this._base = null;
    this._pulse = null;
    this._musicWanted = false;
    this._pulseAmt = 0;     // 0 = base, 1 = pulse (courant)
    this._pulseTarget = 0;
  }

  init() {
    for (const name of Object.keys(SFX)) this._warm(name);
    if (!this._base) this._base = this._makeMusic(MUSIC.match);
    if (!this._pulse) this._pulse = this._makeMusic(MUSIC.pulse);
  }

  _makeMusic(src) {
    const a = new Audio(src);
    a.preload = 'auto';
    a.loop = true;
    a.volume = 0;
    a.setAttribute('playsinline', '');
    return a;
  }

  /** Débloque l'audio mobile après un geste utilisateur. */
  ensureContext() {
    if (this._unlocked) return;
    this._unlocked = true;
    this._getAudioContext();
    for (const name of Object.keys(SFX)) {
      const a = this._acquire(name);
      if (!a) continue;
      a.volume = 0;
      a.play().then(() => {
        a.pause();
        a.currentTime = 0;
        a.volume = SFX_VOL;
      }).catch(() => {});
    }
    for (const m of [this._base, this._pulse]) {
      if (!m) continue;
      m.volume = 0;
      m.play().then(() => {
        m.pause();
        m.currentTime = 0;
        if (this._musicWanted && !this.isMuted) this._resumeLayers();
      }).catch(() => {});
    }
  }

  _getAudioContext() {
    if (!this._audioCtx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this._audioCtx = new AudioCtx();
    }
    if (this._audioCtx && this._audioCtx.state === 'suspended') {
      this._audioCtx.resume().catch(() => {});
    }
    return this._audioCtx;
  }

  /** Bruitage : Clic/Tick cartoon de la roulette (phase spin) */
  playEventSpinTick() {
    if (this.isMuted) return;
    const ctx = this._getAudioContext();
    if (!ctx) return;

    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const now = ctx.currentTime;

      const freq = 600 + Math.random() * 400;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.4, now + 0.04);

      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.05);
    } catch (_) {}
  }

  /** Bruitage : Slam d'impact cartoon quand la carte se pose */
  playEventSlam() {
    if (this.isMuted) return;
    const ctx = this._getAudioContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;

      // Sub drop impact
      const subOsc = ctx.createOscillator();
      const subGain = ctx.createGain();
      subOsc.type = 'sine';
      subOsc.frequency.setValueAtTime(190, now);
      subOsc.frequency.exponentialRampToValueAtTime(32, now + 0.32);

      subGain.gain.setValueAtTime(0.65, now);
      subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

      subOsc.connect(subGain);
      subGain.connect(ctx.destination);

      subOsc.start(now);
      subOsc.stop(now + 0.33);

      // Noise pop crunch
      const bufferSize = Math.floor(ctx.sampleRate * 0.08);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.25));
      }

      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.35, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);

      noise.connect(noiseGain);
      noiseGain.connect(ctx.destination);

      noise.start(now);
    } catch (_) {}
  }

  /** Bruitage : Fanfare cartoon selon la tonalité (good / bad / chaos) */
  playEventReveal(tone = 'chaos') {
    if (this.isMuted) return;
    const ctx = this._getAudioContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;

      if (tone === 'good') {
        // Arpège victorieux Cartoon (Do - Mi - Sol - Do6)
        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const startTime = now + idx * 0.075;

          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, startTime);

          gain.gain.setValueAtTime(0, startTime);
          gain.gain.linearRampToValueAtTime(0.35, startTime + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.38);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(startTime);
          osc.stop(startTime + 0.42);
        });
      } else if (tone === 'bad') {
        // Alerte danger cartoon
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(340, now);
        osc.frequency.exponentialRampToValueAtTime(110, now + 0.42);

        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.42);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.43);
      } else {
        // Zap / Magic sweep pour Chaos
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(280, now);
        osc.frequency.exponentialRampToValueAtTime(1300, now + 0.16);
        osc.frequency.exponentialRampToValueAtTime(420, now + 0.38);

        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + 0.41);
      }
    } catch (_) {}
  }

  playSFX(name, { volume = SFX_VOL, rate = 1 } = {}) {
    if (this.isMuted || !SFX[name]) return;
    this.ensureContext();
    const a = this._acquire(name);
    if (!a) return;
    try {
      a.pause();
      a.currentTime = 0;
      a.volume = Math.max(0, Math.min(1, volume));
      a.playbackRate = Math.max(0.5, Math.min(2, rate));
      a.play().catch(() => {});
    } catch (_) { /* ignore */ }
  }

  /** Joue une variante au hasard d'une famille, jamais deux fois la même
   *  d'affilée. Rend le nom joué, utile pour les tests. */
  playSFXGroup(group, opts = {}) {
    const list = SFX_GROUPS[group];
    if (!list || !list.length) return null;
    if (!this._lastVariant) this._lastVariant = {};

    let pool = list;
    if (list.length > 1 && this._lastVariant[group]) {
      pool = list.filter((n) => n !== this._lastVariant[group]);
    }
    const name = pool[(Math.random() * pool.length) | 0];
    this._lastVariant[group] = name;
    this.playSFX(name, opts);
    return name;
  }

  playFootstep() {}
  playSprite() {}

  /** Clocher : trois coups espacés (alerte fin de partie). */
  playBellWarning({ volume = 0.82, gap = 1.05 } = {}) {
    if (this.isMuted) return;
    this.ensureContext();
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this.playSFX('bell', { volume }), i * gap * 1000);
    }
  }

  /** Clic UI : un seul listener délégué sur tous les boutons de l'app. */
  bindUIClicks(root = document) {
    if (this._uiBound) return;
    this._uiBound = true;
    root.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      const btn = e.target.closest?.(
        'button, [role="button"], .diff-btn, .card-nav-btn, .card-dot, .prog-skills-btn, .swatch, .symbol-btn, .skill-seal, .skill-node, .skill-oracle-cta'
      );
      if (!btn) return;
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
      if (btn.classList.contains('off')) return;
      this.playUIClick();
    }, true);
  }

  /** Clic UI (boutons + sélections canvas). Anti-double déclenchement ~90 ms. */
  playUIClick({ volume = 0.55 } = {}) {
    const now = performance.now();
    if (this._lastUIClick && now - this._lastUIClick < 90) return;
    this._lastUIClick = now;
    this.playSFX('ui_click', { volume });
  }

  /** Musique de match : base au départ, Pulse en fin de journée. */
  startBiomeAmbient(_biomeKey) {
    this.init();
    this._musicWanted = true;
    this._pulseAmt = 0;
    this._pulseTarget = 0;
    if (this.isMuted) return;
    this.ensureContext();
    try {
      for (const m of [this._base, this._pulse]) {
        if (!m) continue;
        m.loop = true;
        m.pause();
        m.currentTime = 0;
        m.volume = 0;
      }
      this._applyMix();
      this._resumeLayers();
    } catch (_) { /* ignore */ }
  }

  stopBiomeAmbient() {
    this._musicWanted = false;
    this._pulseAmt = 0;
    this._pulseTarget = 0;
    for (const m of [this._base, this._pulse]) {
      if (!m) continue;
      try {
        m.pause();
        m.currentTime = 0;
        m.volume = 0;
      } catch (_) { /* ignore */ }
    }
  }

  /** 0 = thème calme, 1 = Pulse. Appelé chaque frame pendant la partie. */
  setMusicIntensity(t) {
    this._pulseTarget = t >= 0.58 ? 1 : 0;
  }

  /** Crossfade base ↔ pulse. À appeler dans la boucle de jeu. */
  updateMusic(dt) {
    if (!this._musicWanted || this.isMuted) return;
    if (this._pulseAmt === this._pulseTarget) {
      this._applyMix();
      return;
    }
    const step = (dt || 0.016) / MUSIC_XFADE;
    if (this._pulseAmt < this._pulseTarget) {
      this._pulseAmt = Math.min(this._pulseTarget, this._pulseAmt + step);
    } else {
      this._pulseAmt = Math.max(this._pulseTarget, this._pulseAmt - step);
    }
    this._applyMix();
    this._resumeLayers();
  }

  _applyMix() {
    const k = this._pulseAmt;
    if (this._base) this._base.volume = MUSIC_VOL * (1 - k);
    if (this._pulse) this._pulse.volume = MUSIC_VOL * k;
  }

  _resumeLayers() {
    if (!this._musicWanted || this.isMuted) return;
    const k = this._pulseAmt;
    if (this._base && k < 0.999 && this._base.paused) {
      this._base.play().catch(() => {});
    }
    if (this._pulse && k > 0.001 && this._pulse.paused) {
      /* Aligne grossièrement le pulse sur la base pour éviter un cut sec. */
      if (this._base && !this._base.paused) {
        try { this._pulse.currentTime = this._base.currentTime; } catch (_) {}
      }
      this._pulse.play().catch(() => {});
    }
    if (this._base && k >= 0.999 && !this._base.paused) this._base.pause();
    if (this._pulse && k <= 0.001 && !this._pulse.paused) this._pulse.pause();
  }

  _warm(name) {
    const a = this._make(name);
    if (a) {
      const list = this._pool.get(name) || [];
      list.push(a);
      this._pool.set(name, list);
    }
  }

  _make(name) {
    const src = SFX[name];
    if (!src) return null;
    const a = new Audio(src);
    a.preload = 'auto';
    a.setAttribute('playsinline', '');
    return a;
  }

  _acquire(name) {
    let list = this._pool.get(name);
    if (!list) {
      list = [];
      this._pool.set(name, list);
    }
    let free = list.find((a) => a.paused || a.ended);
    if (!free) {
      free = this._make(name);
      if (free) list.push(free);
    }
    return free;
  }
}

export const soundEngine = new SoundEngine();
