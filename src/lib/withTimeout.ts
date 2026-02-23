export function withTimeout<T>(
  promise: Promise<T>,
  ms: number = 10000,
  label: string = 'Operation'
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(label + ' timed out after ' + (ms / 1000) + 's — check your connection'))
    }, ms)

    promise
      .then(result => { clearTimeout(timer); resolve(result) })
      .catch(err => { clearTimeout(timer); reject(err) })
  })
}
