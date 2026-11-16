import type { ServerResponse } from 'node:http'

export const sendJson = (
  res: ServerResponse,
  status: number,
  body: object,
  headers: Readonly<Record<string, string>> = {}
): void => {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export const parseUrl = (url: string, host: string): URL => {
  return new URL(url, `http://${host}`)
}
