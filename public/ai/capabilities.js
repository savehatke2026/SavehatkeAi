/* ============================================================
   SaveHatke AI — runtime capability detection.

   Honest gating: the UI must never offer on-device inference it cannot
   actually run. WebGPU is required for the browser model. This reports
   what the device can do so the controller can either load the model or
   explain, truthfully, why it cannot and what the alternatives are.
   ============================================================ */

/** @returns {Promise<{webgpu:boolean, adapter:boolean, reason:string}>} */
export async function detectCapabilities() {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return {
      webgpu: false,
      adapter: false,
      reason: 'This browser does not expose WebGPU. On-device SaveHatke AI '
        + 'needs a WebGPU-capable browser (recent Chrome, Edge, or Chrome on '
        + 'Android; Safari 17+ with the feature enabled).',
    };
  }

  try {
    // Requesting an adapter is the only reliable signal that WebGPU is not
    // merely present in the API surface but actually usable on this device.
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return {
        webgpu: true,
        adapter: false,
        reason: 'WebGPU is present but no GPU adapter is available. This often '
          + 'means hardware acceleration is disabled in the browser settings.',
      };
    }
    return { webgpu: true, adapter: true, reason: '' };
  } catch (error) {
    return {
      webgpu: true,
      adapter: false,
      reason: 'WebGPU could not initialise on this device: '
        + (error && error.message ? error.message : 'unknown error'),
    };
  }
}
