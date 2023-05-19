import YieldStats from './YieldStats'
import VolumeStats from './VolumeStats'
import TvlStats from './TvlStats'
import { AmmStats } from './AmmStats'
import { PriceStats } from './PriceStats'
import BonderStats from './BonderStats'
import S3Upload from './S3Upload'
import wait from 'wait'

type Options = {
  yields?: boolean
  prices?: boolean
  tvl?: boolean
  amm?: boolean
  ammDays?: number
  ammOffsetDays?: number
  ammTokens?: string[]
  ammChains?: string[]
  volume?: boolean
  bonder?: boolean
  bonderProfit?: boolean
  bonderFees?: boolean
  bonderTxFees?: boolean
  regenesis?: boolean
  days?: number
  offsetDays?: number
  bonderDays?: number
  bonderStartDate?: string
  bonderEndDate?: string
  bonderTokens?: string[]
  pollIntervalSeconds?: number
  pricesPollIntervalSeconds?: number
}

class Worker {
  yieldStats: YieldStats
  priceStats: PriceStats
  volumeStats: VolumeStats
  tvlStats: TvlStats
  ammStats: AmmStats
  bonderStats: BonderStats
  hosting = new S3Upload()
  pollIntervalMs: number = 60 * 60 * 1000
  pricesPollIntervalMs: number = 5 * 60 * 1000
  yields: boolean = false
  prices: boolean = false
  tvl: boolean = false
  amm: boolean = false
  volume: boolean = false
  bonder: boolean = false

  constructor (options: Options = {}) {
    let {
      yields,
      prices,
      tvl,
      amm,
      ammDays,
      ammOffsetDays,
      ammTokens,
      ammChains,
      volume,
      regenesis,
      days,
      offsetDays,
      bonder,
      bonderProfit,
      bonderFees,
      bonderTxFees,
      bonderDays,
      bonderStartDate,
      bonderEndDate,
      bonderTokens,
      pollIntervalSeconds,
      pricesPollIntervalSeconds
    } = options
    this.yields = yields
    this.prices = prices
    this.tvl = tvl
    this.amm = amm
    this.volume = volume
    if (pollIntervalSeconds) {
      this.pollIntervalMs = pollIntervalSeconds * 1000
    }
    if (pricesPollIntervalSeconds) {
      this.pricesPollIntervalMs = pricesPollIntervalSeconds * 1000
    }

    if (bonder || bonderProfit || bonderFees || bonderTxFees) {
      this.bonder = true
    }
    this.yieldStats = new YieldStats()
    this.priceStats = new PriceStats()
    this.volumeStats = new VolumeStats({
      regenesis
    })
    this.tvlStats = new TvlStats({
      regenesis,
      days
    })
    this.ammStats = new AmmStats({
      regenesis,
      days: ammDays,
      offsetDays: ammOffsetDays,
      tokens: ammTokens,
      chains: ammChains
    })
    this.bonderStats = new BonderStats({
      days: bonderDays,
      offsetDays: offsetDays,
      startDate: bonderStartDate,
      endDate: bonderEndDate,
      tokens: bonderTokens,
      trackBonderProfit: bonderProfit ?? bonder,
      trackBonderFees: bonderFees ?? bonder,
      trackBonderTxFees: bonderTxFees ?? bonder
    })
  }

  async start () {
    console.log('worker started')
    console.log(`polling every ${this.pollIntervalMs}ms`)
    const promises: Promise<any>[] = []
    if (this.yields) {
      promises.push(this.yieldStatsPoll())
    }
    if (this.prices) {
      promises.push(this.priceStatsPoll())
    }
    if (this.tvl) {
      promises.push(this.tvlStatsPoll())
    }
    if (this.amm) {
      promises.push(this.ammStatsPoll())
    }
    if (this.volume) {
      promises.push(this.volumeStatsPoll())
    }
    if (this.bonder) {
      promises.push(this.bonderStatsPoll())
    }
    if (!promises.length) {
      throw new Error('at least one option is required')
    }
    await Promise.all(promises)
  }

  async volumeStatsPoll () {
    console.log('volumeStatsPoll started')
    while (true) {
      try {
        console.log(`fetching volume stats (${new Date()})`)
        await this.volumeStats.trackDailyVolume()
        console.log('done tracking volume stats')
      } catch (err) {
        console.error(err)
      }
      await wait(this.pollIntervalMs)
    }
  }

  async tvlStatsPoll () {
    console.log('tvlStatsPoll started')
    while (true) {
      try {
        console.log(`fetching tvl stats (${new Date()})`)
        await this.tvlStats.trackTvl()
        console.log('done tracking tvl stats')
      } catch (err) {
        console.error(err)
      }
      await wait(this.pollIntervalMs)
    }
  }

  async ammStatsPoll () {
    console.log('ammStatsPoll started')
    while (true) {
      try {
        console.log(`fetching amm stats (${new Date()})`)
        await this.ammStats.trackAmm()
        console.log('done tracking amm stats')
      } catch (err) {
        console.error(err)
      }
      await wait(this.pollIntervalMs)
    }
  }

  async yieldStatsPoll () {
    console.log('yieldStatsPoll started')
    while (true) {
      try {
        console.log(`fetching yield stats (${new Date()})`)
        const res = await this.yieldStats.getAllYields()
        const { legacyYieldData, yieldData } = res.yieldDatas
        const legacyKey = 'v1-pool-stats.json'
        await this.hosting.upload(legacyKey, legacyYieldData)
        const key = 'v1.1-pool-stats.json'
        await this.hosting.upload(key, yieldData)
        console.log('done uploading yield stats')
      } catch (err) {
        console.error(err)
      }
      await wait(this.pollIntervalMs)
    }
  }

  async priceStatsPoll () {
    console.log('priceStatsPoll started')
    while (true) {
      try {
        console.log(`fetching price stats (${new Date()})`)
        const json = await this.priceStats.getPricesJson()
        const filename = 'token-prices.json'
        await this.hosting.upload(filename, json)
        console.log('done uploading price stats')
      } catch (err) {
        console.error(err)
      }
      console.log(`waiting ${this.pricesPollIntervalMs}ms for next prices poll`)
      await wait(this.pricesPollIntervalMs)
    }
  }

  async bonderStatsPoll () {
    console.log('bonderStatsPoll started')
    while (true) {
      try {
        console.log(`fetching bonder stats (${new Date()})`)
        await this.bonderStats.run()
        console.log('done tracking bonder stats')
      } catch (err) {
        console.error(err)
      }
      await wait(this.pollIntervalMs)
    }
  }
}

export default Worker
