// wait util will wait specified amount of time in milliseconds
export const wait = async (timeoutMs: number) => {
  return new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
}

export default wait
