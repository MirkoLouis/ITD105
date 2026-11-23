// 1. Activation functions and their derivatives
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const dSigmoid = (y) => y * (1 - y); // where y = sigmoid(x)
const tanh = (x) => Math.tanh(x);
const dTanh = (y) => 1 - y * y;      // where y = tanh(x)

export class TinyLSTM {
  constructor() {
    // Initialize random weights for [prevHidden, currentInput] -> 2 inputs per gate
    const rand = () => (Math.random() - 0.5) * 0.5;

    // Forget gate weights & bias
    this.wf = [rand(), rand()];
    this.bf = 0;

    // Input gate weights & bias
    this.wi = [rand(), rand()];
    this.bi = 0;

    // Candidate memory weights & bias
    this.wc = [rand(), rand()];
    this.bc = 0;

    // Output gate weights & bias
    this.wo = [rand(), rand()];
    this.bo = 0;

    // Final linear output layer weights & bias (to predict unbounded numbers)
    this.wy = rand();
    this.by = 0;
  }

  // Forward pass over a sequence window (e.g., [1, 2])
  forward(sequence) {
    let h = 0; // Short-term hidden state
    let c = 0; // Long-term cell state
    const cache = [];

    for (let t = 0; t < sequence.length; t++) {
      const x = sequence[t];
      const hPrev = h;
      const cPrev = c;

      // Gate calculations: W * [hPrev, x] + b
      const f = sigmoid(this.wf[0] * hPrev + this.wf[1] * x + this.bf);
      const i = sigmoid(this.wi[0] * hPrev + this.wi[1] * x + this.bi);
      const cTilde = tanh(this.wc[0] * hPrev + this.wc[1] * x + this.bc);
      const o = sigmoid(this.wo[0] * hPrev + this.wo[1] * x + this.bo);

      // Update cell state and hidden state
      c = f * cPrev + i * cTilde;
      const tanhC = tanh(c);
      h = o * tanhC;

      cache.push({ x, hPrev, cPrev, f, i, cTilde, o, c, tanhC, h });
    }

    // Linear output layer maps final hidden state to prediction
    const yPred = this.wy * h + this.by;
    return { yPred, cache };
  }

  // Train on one window using Backpropagation Through Time (BPTT)
  trainStep(sequence, target, lr = 0.01) {
    const { yPred, cache } = this.forward(sequence);
    const error = yPred - target;

    // Update output layer
    const lastH = cache[cache.length - 1].h;
    this.wy -= lr * error * lastH;
    this.by -= lr * error;

    // Backpropagate gradients through time steps
    let dhNext = error * this.wy;
    let dcNext = 0;

    for (let t = cache.length - 1; t >= 0; t--) {
      const { x, hPrev, cPrev, f, i, cTilde, o, tanhC } = cache[t];

      // Gradients for gates
      const doGate = dhNext * tanhC * dSigmoid(o);
      const dc = dhNext * o * dTanh(tanhC) + dcNext;
      const dfGate = dc * cPrev * dSigmoid(f);
      const diGate = dc * cTilde * dSigmoid(i);
      const dcTilde = dc * i * dTanh(cTilde);

      // Update weights and biases
      this.wf[0] -= lr * dfGate * hPrev;
      this.wf[1] -= lr * dfGate * x;
      this.bf -= lr * dfGate;

      this.wi[0] -= lr * diGate * hPrev;
      this.wi[1] -= lr * diGate * x;
      this.bi -= lr * diGate;

      this.wc[0] -= lr * dcTilde * hPrev;
      this.wc[1] -= lr * dcTilde * x;
      this.bc -= lr * dcTilde;

      this.wo[0] -= lr * doGate * hPrev;
      this.wo[1] -= lr * doGate * x;
      this.bo -= lr * doGate;

      // Pass gradients to previous time step
      dhNext =
        dfGate * this.wf[0] +
        diGate * this.wi[0] +
        dcTilde * this.wc[0] +
        doGate * this.wo[0];
      dcNext = dc * f;
    }
  }
}
