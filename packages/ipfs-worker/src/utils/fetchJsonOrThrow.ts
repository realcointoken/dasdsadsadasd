import fetch from 'isomorphic-fetch'
import { promiseTimeout } from './promiseTimeout'

export async function fetchJsonOrThrow (
  url: string,
  timeoutMs: number = 5 * 1000
) {
  let signal: any
  if (typeof AbortController !== 'undefined') {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), timeoutMs)
    signal = controller.signal
  }
  const res = await (signal
    ? fetch(url, { signal })
    : promiseTimeout(fetch(url), timeoutMs))
  const json = await res.json()
  if (!json || !(json instanceof Object)) {
    throw new Error('expected json object for response')
  }
  return json
}
