/* ==========================================================================
   Cult War — Sound Engine (SFX + musique de partie)
   ========================================================================== */

/* Chemins relatifs à BASE_URL (vite `base: './'`) : obligatoire sur GitHub Pages
   (/cultwar/) et Capacitor — un chemin absolu `/assets/...` renvoie 404. */
const asset = (file) => `${import.meta.env.BASE_URL}assets/${file}`;

const SFX = {
  convert: asset('sfx_convert.mp3'),
  ui_click: asset('sfx_click.mp3'),
  defeat: asset('sfx_defeat.mp3'),
  disciple: asset('sfx_disciple.mp3'),
  disciple_alien: asset('sfx_disciple_alien.mp3'),
  bell: asset('sfx_bell.mp3'),
  crystal: asset('sfx_crystal_explode.mp3'),
  paint_orb: asset('sfx_paint_orb.mp3'),
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
