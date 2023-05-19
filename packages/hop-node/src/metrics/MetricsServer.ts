import Logger from 'src/logger'
import express, { Express } from 'express'
import { Registry, collectDefaultMetrics } from 'prom-client'
import { metrics } from './metrics'

export class MetricsServer {
  private readonly app: Express
  private readonly registry: Registry
  private readonly logger: Logger

  constructor (private readonly port = 8080) {
    this.logger = new Logger('Metrics')
    this.registry = new Registry()
    MetricsServer._registerCustomMetrics(this.registry)
    this.app = express()
    this.app.get('/metrics', async (req, resp) => {
      resp.setHeader('Content-Type', this.registry.contentType)
      resp.send(await this.registry.metrics())
    })
  }

  async start () {
    collectDefaultMetrics({
      register: this.registry,
      gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5]
    })
    this.app.listen(this.port, () => {
      this.logger.info(`metrics server listening on port ${this.port} at /metrics`)
    })
  }

  private static _registerCustomMetrics (registry: Registry): void {
    for (const metric of Object.values(metrics)) {
      registry.registerMetric(metric)
    }
  }
}
