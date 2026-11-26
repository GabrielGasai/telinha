// Microfone com cancelamento de ruído.
//
// Três camadas, todas no próprio PC:
//   1. a redução de ruído e o cancelamento de eco do navegador (tiram o grosso
//      do ventilador, do chiado e do som que sai das caixas);
//   2. filtros que cortam o que não é voz: o ronco grave (abaixo de 100 Hz) e o
//      chiado agudo (acima de 8 kHz);
//   3. um portão de ruído: o microfone fica mudo enquanto a pessoa não fala.
// O portão também diz quando a pessoa está falando (o nome dela acende na lista).
export async function openMic({ onSpeaking } = {}) {
  const want = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  // Alguns Windows/Chrome têm isolamento de voz melhor; usa se existir.
  const sup = navigator.mediaDevices.getSupportedConstraints?.() || {}
  if (sup.voiceIsolation) want.voiceIsolation = true
  const raw = await navigator.mediaDevices.getUserMedia({ audio: want, video: false })

  const ctx = new AudioContext({ latencyHint: 'interactive' })
  await ctx.resume().catch(() => {})
  const src = ctx.createMediaStreamSource(raw)
  const low = ctx.createBiquadFilter()
  low.type = 'highpass'
  low.frequency.value = 100
  low.Q.value = 0.7
  const high = ctx.createBiquadFilter()
  high.type = 'lowpass'
  high.frequency.value = 8000
  high.Q.value = 0.7
  const dest = ctx.createMediaStreamDestination()
  src.connect(low).connect(high)

  let gate = null
  try {
    await ctx.audioWorklet.addModule('/noise-gate.js')
    gate = new AudioWorkletNode(ctx, 'noise-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    gate.port.onmessage = (e) => onSpeaking?.(!!e.data)
    high.connect(gate).connect(dest)
  } catch {
    // Sem o portão, segue só com os filtros.
    high.connect(dest)
  }

  return {
    stream: dest.stream,
    track: dest.stream.getAudioTracks()[0],
    stop() {
      if (gate) gate.port.onmessage = null
      raw.getTracks().forEach((t) => t.stop())
      dest.stream.getTracks().forEach((t) => t.stop())
      ctx.close().catch(() => {})
      onSpeaking?.(false)
    },
  }
}
