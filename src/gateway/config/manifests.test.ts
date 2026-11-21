import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import yaml from 'yaml'

const manifest = <T>(name: string): T =>
  yaml.parse(readFileSync(resolve(process.cwd(), 'config/base', name), 'utf8')) as T

interface ServicePort {
  name: string
  port: number
  targetPort: string
}

const route = manifest<{
  spec: { rules: { backendRefs: { name: string; port: number }[] }[] }
}>('http-route.yaml')
const service = manifest<{ spec: { ports: ServicePort[] } }>('service.yaml')
const deployment = manifest<{
  spec: {
    template: {
      spec: { containers: { ports: { name: string; containerPort: number }[] }[] }
    }
  }
}>('deployment.yaml')

const servicePort = (name: string) => service.spec.ports.find((p) => p.name === name)
const containerPorts = deployment.spec.template.spec.containers[0].ports

// The internal and metrics ports skip the token check, so they must never be
// routable from a Gateway listener.
describe('exposed ports', () => {
  it('routes only the token-checked GraphQL port', () => {
    const ports = route.spec.rules.flatMap((r) => r.backendRefs.map((b) => b.port))
    expect(ports).toEqual([servicePort('https')?.port])
    expect(ports).toEqual([4000])
  })

  it.each([
    ['https', 4000],
    ['internal', 4001],
    ['metrics', 9464],
  ])('exposes the %s port as %i on the Service and the container', (name, port) => {
    expect(servicePort(name)).toMatchObject({ port, targetPort: name })
    expect(containerPorts).toContainEqual(expect.objectContaining({ name, containerPort: port }))
  })
})
