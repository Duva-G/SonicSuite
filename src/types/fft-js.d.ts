declare module "fft.js" {
  export default class FFT {
    constructor(size: number);
    createComplexArray(): Float32Array;
    realTransform(out: Float32Array, data: Float32Array): void;
    completeSpectrum(out: Float32Array): void;
    inverseTransform(out: Float32Array, data: Float32Array): void;
    fromComplexArray(complex: Float32Array, result: Float32Array): Float32Array;
  }
}
