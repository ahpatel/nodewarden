/* Spotlight wiring for the "Crisp" surface theme: one delegated passive
   pointermove listener feeds --spot-x/--spot-y on the hovered card or vault
   row; the visual is pure CSS in styles/surface-crisp.css. Gated per event on
   the surface preference and on hover-capable fine pointers, so touch devices
   never track (and never get sticky glows). */

const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)';

let bound = false;
let finePointer = true;

export function initSpotlight(): void {
  if (bound || typeof document === 'undefined') return;
  bound = true;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    finePointer = window.matchMedia(FINE_POINTER_QUERY).matches;
  }
  document.addEventListener('pointermove', (event) => {
    if (document.documentElement.dataset.surface !== 'crisp') return;
    if (!finePointer) return;
    if (!(event.target instanceof Element)) return;
    const host = event.target.closest('.card, .list-item');
    if (!(host instanceof HTMLElement)) return;
    const rect = host.getBoundingClientRect();
    host.style.setProperty('--spot-x', `${Math.round(event.clientX - rect.left)}px`);
    host.style.setProperty('--spot-y', `${Math.round(event.clientY - rect.top)}px`);
  }, { passive: true });
}
