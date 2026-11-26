// Portão de ruído do microfone (roda na thread de áudio, não trava com o app minimizado).
//
// Enquanto a pessoa não fala, o microfone fica mudo: some o chiado, o ventilador
// e o barulho da casa que sobraram depois da redução de ruído do navegador.
// Quando a voz passa do nível do ruído de fundo, o som abre na hora.
// Também avisa o app quando a pessoa começa e para de falar (para o nome acender).
class NoiseGate extends AudioWorkletProcessor {
  constructor() {
    super()
    this.floor = 0.004 // nível do ruído de fundo (aprende sozinho)
    this.gain = 0
    this.hold = 0
    this.open = false
    this.attack = 1 - Math.exp(-1 / (0.004 * sampleRate)) // abre em ~4 ms
    this.release = 1 - Math.exp(-1 / (0.09 * sampleRate)) // fecha em ~90 ms
    this.holdSamples = Math.round(0.3 * sampleRate) // segura aberto 300 ms após a fala
    // Sensibilidade: automática (aprende o ruído) ou um limite escolhido pela pessoa.
    this.auto = true
    this.manual = 0.01
    this.peak = 0
    this.blocks = 0
    this.port.onmessage = (e) => {
      const d = e.data || {}
      if (typeof d.auto === 'boolean') this.auto = d.auto
      if (typeof d.threshold === 'number') this.manual = d.threshold
    }
  }

  process(inputs, outputs) {
    const inp = inputs[0]
    const out = outputs[0]
    if (!inp || !inp[0]) return true
    const x = inp[0]
    let sum = 0
    for (let i = 0; i < x.length; i++) sum += x[i] * x[i]
    const rms = Math.sqrt(sum / x.length)

    // O ruído de fundo desce rápido e sobe devagar (para não confundir voz com ruído).
    if (rms < this.floor) this.floor += (rms - this.floor) * 0.1
    else this.floor *= 1.0002
    this.floor = Math.min(0.05, Math.max(0.0004, this.floor))

    const threshold = this.auto ? Math.max(this.floor * 3.5, 0.006) : this.manual
    if (rms > threshold) this.hold = this.holdSamples
    else this.hold -= x.length
    const want = this.hold > 0 ? 1 : 0

    const open = want === 1
    if (open !== this.open) {
      this.open = open
      this.port.postMessage({ t: 'talk', v: open })
    }
    // Nível do som para a barrinha de sensibilidade (~20 vezes por segundo).
    this.peak = Math.max(this.peak, rms)
    if (++this.blocks >= 18) {
      this.port.postMessage({ t: 'lvl', v: this.peak, thr: threshold })
      this.peak = 0
      this.blocks = 0
    }

    for (let i = 0; i < x.length; i++) {
      this.gain += (want - this.gain) * (want > this.gain ? this.attack : this.release)
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.gain
    }
    return true
  }
}

registerProcessor('noise-gate', NoiseGate)
