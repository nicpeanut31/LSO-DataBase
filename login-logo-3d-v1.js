(() => {
  'use strict';

  const scene = document.getElementById('authLogoScene');
  if (!scene) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  let frame = 0;

  function setRestingPosition() {
    scene.classList.remove('is-interacting');
    scene.style.setProperty('--logo-rotate-x', '-3deg');
    scene.style.setProperty('--logo-rotate-y', '6deg');
    scene.style.setProperty('--logo-shift-x', '0px');
    scene.style.setProperty('--logo-shift-y', '0px');
    scene.style.setProperty('--logo-light-x', '38%');
    scene.style.setProperty('--logo-light-y', '24%');
  }

  function renderPointer(clientX, clientY) {
    const rect = scene.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const x = Math.max(-1, Math.min(1, ((clientX - rect.left) / rect.width - .5) * 2));
    const y = Math.max(-1, Math.min(1, ((clientY - rect.top) / rect.height - .5) * 2));

    scene.style.setProperty('--logo-rotate-x', `${(-3 - y * 8).toFixed(2)}deg`);
    scene.style.setProperty('--logo-rotate-y', `${(6 + x * 11).toFixed(2)}deg`);
    scene.style.setProperty('--logo-shift-x', `${(x * 4).toFixed(2)}px`);
    scene.style.setProperty('--logo-shift-y', `${(y * 3).toFixed(2)}px`);
    scene.style.setProperty('--logo-light-x', `${(50 + x * 31).toFixed(1)}%`);
    scene.style.setProperty('--logo-light-y', `${(48 + y * 28).toFixed(1)}%`);
  }

  function onPointerMove(event) {
    if (reducedMotion.matches || !finePointer.matches) return;
    scene.classList.add('is-interacting');
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => renderPointer(event.clientX, event.clientY));
  }

  function onPointerLeave() {
    cancelAnimationFrame(frame);
    setRestingPosition();
  }

  scene.addEventListener('pointermove', onPointerMove, { passive: true });
  scene.addEventListener('pointerleave', onPointerLeave, { passive: true });
  scene.addEventListener('pointercancel', onPointerLeave, { passive: true });
  reducedMotion.addEventListener?.('change', setRestingPosition);
  finePointer.addEventListener?.('change', setRestingPosition);
  setRestingPosition();
})();
