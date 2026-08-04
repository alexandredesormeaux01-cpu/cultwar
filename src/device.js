/* ============================================================================
   Détection de plateforme — un seul verdict pour tout le jeu
   ----------------------------------------------------------------------------
   Le test historique était `matchMedia('(pointer: coarse)')`, répété dans cinq
   modules. Il est faux sur les machines hybrides : un portable Windows à écran
   tactile déclare un pointeur primaire « coarse » alors qu'il a une souris et
   un GPU de bureau. Résultat, ces machines héritaient de tout le budget mobile
   — plafond d'agents réduit, préréglage graphique bas, 30 fps, et surtout
   AUCUN contour cartoon sur la foule.

   Le bon test est la présence d'un pointeur fin : `any-pointer: fine` répond
   « oui » dès qu'une souris ou un stylet existe, quel que soit le pointeur
   primaire. On ne dégrade donc que les appareils réellement tactiles seuls.
   ========================================================================== */

/** Une souris ou un stylet est disponible (portable tactile compris). */
export const HAS_FINE_POINTER = matchMedia('(any-pointer: fine)').matches;

/** L'appareil possède un écran tactile — dit seulement ça, rien sur la puissance. */
export const HAS_TOUCH = matchMedia('(any-pointer: coarse)').matches;

/* Application native Capacitor : le pont injecte `window.Capacitor` AVANT le
   chargement de la page, la valeur est donc lisible dès l'import.

   Ce test n'est pas un raffinement : la WebView Android répond « oui » à
   `any-pointer: fine` sur beaucoup d'appareils (support du stylet, souris
   Bluetooth, émulateur). L'heuristique seule classait donc un téléphone en
   desktop — et comme l'APK n'embarque que les modèles allégés, tous les
   personnages tombaient sur leur fallback géométrique. Un APK est mobile,
   point. */
export const IS_NATIVE = !!(globalThis.Capacitor
  && (globalThis.Capacitor.isNativePlatform?.() ?? globalThis.Capacitor.isNative));

/** Budget mobile : application native, ou tactile sans pointeur fin. */
export const IS_MOBILE = IS_NATIVE || (HAS_TOUCH && !HAS_FINE_POINTER);

/** Pour le diagnostic console (window.__cult.env()). */
export function describeDevice() {
  return {
    isMobile: IS_MOBILE,
    isNative: IS_NATIVE,
    hasTouch: HAS_TOUCH,
    hasFinePointer: HAS_FINE_POINTER,
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
    hover: matchMedia('(hover: hover)').matches,
    dpr: window.devicePixelRatio,
    ua: navigator.userAgent,
  };
}
