/**
 * Bootstrap Capacitor : barre de statut, splash, pause WebGL en arrière-plan.
 * No-op dans le navigateur (imports dynamiques).
 */
export async function initNative() {
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) return;

    const [{ StatusBar, Style }, { SplashScreen }, { App }] = await Promise.all([
      import('@capacitor/status-bar'),
      import('@capacitor/splash-screen'),
      import('@capacitor/app'),
    ]);

    await StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
    await StatusBar.setBackgroundColor({ color: '#0b1020' }).catch(() => {});
    await StatusBar.hide().catch(() => {});
    await SplashScreen.hide().catch(() => {});

    App.addListener('appStateChange', ({ isActive }) => {
      document.body.classList.toggle('app-paused', !isActive);
      window.dispatchEvent(new CustomEvent('cultio:visibility', { detail: { active: isActive } }));
    });
  } catch {
    // Navigateur ou plugins absents
  }
}
