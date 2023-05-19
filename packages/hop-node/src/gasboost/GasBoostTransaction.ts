import BNMax from 'src/utils/BNMax'
import BNMin from 'src/utils/BNMin'
import Logger from 'src/logger'
import Store from './Store'
import chainSlugToId from 'src/utils/chainSlugToId'
import fetch from 'node-fetch'
import getBumpedBN from 'src/utils/getBumpedBN'
import getBumpedGasPrice from 'src/utils/getBumpedGasPrice'
import getProviderChainSlug from 'src/utils/getProviderChainSlug'
import getTransferIdFromCalldata from 'src/utils/getTransferIdFromCalldata'
import wait from 'src/utils/wait'
import { BigNumber, Signer, providers } from 'ethers'
import {
  Chain,
  InitialTxGasPriceMultiplier,
  MaxGasPriceMultiplier,
  MaxPriorityFeeConfidenceLevel,
  MinPriorityFeePerGas,
  PriorityFeePerGasCap
} from 'src/constants'
import { EventEmitter } from 'events'

import { EstimateGasError, KmsSignerError, NonceTooLowError } from 'src/types/error'
import { Notifier } from 'src/notifier'
import {
  blocknativeApiKey,
  gasBoostErrorSlackChannel,
  gasBoostWarnSlackChannel,
  hostname
} from 'src/config'
import { formatUnits, hexlify, parseUnits } from 'ethers/lib/utils'
import { v4 as uuidv4 } from 'uuid'

enum State {
  Confirmed = 'confirmed',
  Boosted = 'boosted',
  MaxGasPriceReached = 'maxGasPriceReached',
  Reorg = 'reorg',
  Error = 'error'
}

type InflightItem = {
  hash?: string
  boosted: boolean
  sentAt: number
}

type MarshalledItem = {
  id: string
  createdAt: number
  txHash?: string
  type?: number
  from: string
  to: string
  data: string
  value: string
  nonce: number
  gasPrice?: string
  maxFeePerGas?: string
  maxPriorityFeePerGas?: string
  gasLimit: string
}

export type Options = {
  pollMs: number
  timeTilBoostMs: number
  gasPriceMultiplier: number
  initialTxGasPriceMultiplier: number
  maxGasPriceGwei: number
  minPriorityFeePerGas: number
  priorityFeePerGasCap: number
  compareMarketGasPrice: boolean
  reorgWaitConfirmations: number
  maxPriorityFeeConfidenceLevel: number
}

type Type0GasData = {
  gasPrice: BigNumber
}

type Type2GasData = {
  maxFeePerGas: BigNumber
  maxPriorityFeePerGas: BigNumber
}

type GasFeeData = Type0GasData & Type2GasData

const enoughFundsCheckCache: Record<string, number> = {}

class GasBoostTransaction extends EventEmitter implements providers.TransactionResponse {
  started: boolean = false
  pollMs: number = 10 * 1000
  timeTilBoostMs: number = 3 * 60 * 1000
  gasPriceMultiplier: number = MaxGasPriceMultiplier // multiplier for gasPrice
  initialTxGasPriceMultiplier: number = InitialTxGasPriceMultiplier // multiplier for gasPrice for first tx
  maxGasPriceGwei: number = 500 // the max we'll keep bumping gasPrice in type 0 txs
  maxGasPriceReached: boolean = false // this is set to true when gasPrice is greater than maxGasPrice
  maxRebroadcastIndex: number = 10
  maxRebroadcastIndexReached: boolean = false
  minPriorityFeePerGas: number = MinPriorityFeePerGas // we use this priorityFeePerGas or the ethers suggestions; which ever one is greater
  priorityFeePerGasCap: number = PriorityFeePerGasCap // this the max we'll keep bumping maxPriorityFeePerGas to in type 2 txs. Since maxPriorityFeePerGas is already a type 2 argument, it uses the term cap instead
  maxPriorityFeeConfidenceLevel: number = MaxPriorityFeeConfidenceLevel
  compareMarketGasPrice: boolean = true
  warnEthBalance: number = 0.1 // how low ETH balance of signer must get before we log a warning
  boostIndex: number = 0 // number of times transaction has been boosted
  rebroadcastIndex: number = 0 // number of times transaction has been rebroadcasted
  inflightItems: InflightItem[] = []
  signer: Signer
  store: Store
  logger: Logger
  notifier: Notifier
  chainSlug: string
  id: string
  createdAt: number
  txHash?: string
  receipt?: providers.TransactionReceipt
  private _is1559Supported: boolean // set to true if EIP-1559 type transactions are supported
  readonly minMultiplier: number = 1.10 // the minimum gas price multiplier that miners will accept for transaction replacements
  logId: string

  reorgWaitConfirmations: number = 1
  originalTxParams: providers.TransactionRequest

  type?: number

  // these properties are required by ethers TransactionResponse interface
  from: string // type 0 and 2 tx required property
  to: string // type 0 and 2 tx required property
  data: string // type 0 and 2 tx required property
  value: BigNumber // type 0 and 2 tx required property
  nonce: number // type 0 and 2 tx required property
  gasLimit: BigNumber // type 0 and 2 tx required property
  gasPrice?: BigNumber // type 0 tx required property
  maxFeePerGas?: BigNumber // type 2 tx required property
  maxPriorityFeePerGas?: BigNumber // type 2 tx required property
  chainId: number // type 0 and 2 tx required property
  confirmations: number = 0 // type 0 and 2 tx required property

  constructor (tx: providers.TransactionRequest, signer: Signer, store: Store, options: Partial<Options> = {}, id?: string) {
    super()
    this.signer = signer
    if (store != null) {
      this.store = store
    }
    this.createdAt = Date.now()
    this.originalTxParams = tx
    this.setOwnTxParams(tx)
    this.id = id ?? this.generateId()
    this.setOptions(options)

    const chainSlug = getProviderChainSlug(this.signer.provider)
    if (!chainSlug) {
      throw new Error('chain slug not found for contract provider')
    }
    this.chainSlug = chainSlug
    this.chainId = chainSlugToId(chainSlug)
    const tag = 'GasBoostTransaction'
    let prefix = `${this.chainSlug} id: ${this.id}`
    const transferId = this.decodeTransferId()
    if (transferId) {
      prefix = `${prefix} transferId: ${transferId}`
    }
    this.logId = prefix
    this.logger = new Logger({
      tag,
      prefix
    })
    this.logger.log('starting log')
    this.notifier = new Notifier(
      `GasBoost, label: ${prefix}, host: ${hostname}`
    )
  }

  private generateId (): string {
    return uuidv4()
  }

  private setOwnTxParams (tx: providers.TransactionRequest) {
    this.from = tx.from!
    this.to = tx.to!
    if (tx.type != null) {
      this.type = tx.type
    }
    if (tx.data) {
      this.data = hexlify(tx.data)
    }
    if (tx.value) {
      this.value = BigNumber.from(tx.value)
    }
    if (tx.nonce) {
      this.nonce = BigNumber.from(tx.nonce).toNumber()
    }
    if (tx.gasPrice) {
      this.gasPrice = BigNumber.from(tx.gasPrice)
    } else {
      if (tx.maxFeePerGas) {
        this.maxFeePerGas = BigNumber.from(tx.maxFeePerGas)
      }
      if (tx.maxPriorityFeePerGas) {
        this.maxPriorityFeePerGas = BigNumber.from(tx.maxPriorityFeePerGas)
      }
    }
    if (tx.gasLimit) {
      this.gasLimit = BigNumber.from(tx.gasLimit)
    }
  }

  private setGasProperties (tx: providers.TransactionResponse) {
    // things get complicated with boosting 1559 when initial tx is using gasPrice
    // so we explicitly set gasPrice here again
    const shouldUseGasPrice = this.gasPrice && !tx.gasPrice && tx.maxFeePerGas && tx.maxPriorityFeePerGas && tx.maxFeePerGas.eq(tx.maxPriorityFeePerGas)
    if (shouldUseGasPrice) {
      this.type = undefined
      this.gasPrice = tx.maxFeePerGas
      this.maxFeePerGas = undefined
      this.maxPriorityFeePerGas = undefined
    } else {
      this.gasPrice = tx.gasPrice!
      this.maxFeePerGas = tx.maxFeePerGas!
      this.maxPriorityFeePerGas = tx.maxPriorityFeePerGas!
      if (tx.type != null) {
        this.type = tx.type
      }
    }
  }

  decodeTransferId (): string | undefined {
    if (this.data) {
      try {
        if (this.data?.startsWith('0x3d12a85a') || this.data?.startsWith('0x23c452cd')) {
          const transferId = getTransferIdFromCalldata(this.data, this.chainId)
          if (transferId) {
            return transferId
          }
        }
      } catch (err) {
        // noop
      }
    }
  }

  get hash (): string {
    if (this.txHash) {
      return this.txHash
    }
    const prevItem = this.getLatestInflightItem()
    if (prevItem) {
      return prevItem.hash! // eslint-disable-line
    }
    throw new Error('transaction hash not available yet')
  }

  setPollMs (pollMs: number) {
    this.pollMs = pollMs
  }

  setTimeTilBoostMs (timeTilBoostMs: number) {
    this.timeTilBoostMs = timeTilBoostMs
  }

  setGasPriceMultiplier (gasPriceMultiplier: number) {
    this.gasPriceMultiplier = gasPriceMultiplier
  }

  setInitialTxGasPriceMultiplier (initialTxGasPriceMultiplier: number) {
    this.initialTxGasPriceMultiplier = initialTxGasPriceMultiplier
  }

  setMaxGasPriceGwei (maxGasPriceGwei: number) {
    this.maxGasPriceGwei = maxGasPriceGwei
  }

  setMinPriorityFeePerGas (minPriorityFeePerGas: number) {
    this.minPriorityFeePerGas = minPriorityFeePerGas
  }

  setPriorityFeePerGasCap (priorityFeePerGasCap: number) {
    this.priorityFeePerGasCap = priorityFeePerGasCap
  }

  setCompareMarketGasPrice (compareMarketGasPrice: boolean) {
    this.compareMarketGasPrice = compareMarketGasPrice
  }

  setWarnEthBalance (warnEthBalance: number) {
    this.warnEthBalance = warnEthBalance
  }

  start () {
    this.startPoller()
  }

  async save () {
    if (!this.store) {
      return
    }
    await this.store.updateItem(this.id, this.marshal())
  }

  marshal (): MarshalledItem {
    return {
      id: this.id,
      createdAt: this.createdAt,
      txHash: this.txHash,
      type: this.type,
      from: this.from,
      to: this.to,
      data: this.data,
      value: this.value?.toString(),
      nonce: this.nonce,
      gasPrice: this.gasPrice?.toString(),
      maxFeePerGas: this.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: this.maxPriorityFeePerGas?.toString(),
      gasLimit: this.gasLimit?.toString()
    }
  }

  static async fromId (id: string, signer: Signer, store: Store, options: Partial<Options> = {}) {
    const item = await store.getItem(id)
    return await GasBoostTransaction.unmarshal(item, signer, store, options)
  }

  static async unmarshal (item: MarshalledItem, signer: Signer, store: Store, options: Partial<Options> = {}) {
    const tx = {
      type: item.type,
      from: item.from,
      to: item.to,
      data: item.data,
      value: item.value,
      nonce: item.nonce,
      gasPrice: item.gasPrice,
      maxFeePerGas: item.maxFeePerGas,
      maxPriorityFeePerGas: item.maxPriorityFeePerGas,
      gasLimit: item.gasLimit
    }
    const gTx = new GasBoostTransaction(tx, signer, store)
    gTx.id = item.id
    gTx.createdAt = item.createdAt
    gTx.txHash = item.txHash
    gTx.setOptions(options)
    return gTx
  }

  async send () {
    const _timeId = `GasBoostTransaction send getBumpedGasFeeData elapsed ${this.logId} `
    console.time(_timeId)
    let gasFeeData = await this.getBumpedGasFeeData(this.initialTxGasPriceMultiplier)
    console.timeEnd(_timeId)

    // use passed in tx gas values if they were specified
    if (this.gasPrice) {
      gasFeeData.gasPrice = this.gasPrice
    } else if (this.maxFeePerGas ?? this.maxPriorityFeePerGas) {
      if (this.maxFeePerGas) {
        gasFeeData.maxFeePerGas = this.maxFeePerGas
      }
      if (this.maxPriorityFeePerGas) {
        gasFeeData.maxPriorityFeePerGas = this.maxPriorityFeePerGas
      }
    }

    // clamp gas values to max if they go over max for initial tx send
    gasFeeData = this.clampMaxGasFeeData(gasFeeData)
    const tx = await this._sendTransaction(gasFeeData)

    // store populated and normalized values
    this.from = tx.from
    this.to = tx.to!
    this.data = tx.data
    this.value = tx.value
    this.gasLimit = tx.gasLimit
    this.nonce = tx.nonce
    this.setGasProperties(tx)

    this.logger.debug(`beginning tracking for ${tx.hash}`)
    this.track(tx)
  }

  async getLatestNonce (): Promise<number> {
    return await this.signer.getTransactionCount('pending')
  }

  async getGasFeeData () {
    return await this.signer.provider!.getFeeData() // eslint-disable-line
  }

  async getMarketGasPrice (): Promise<BigNumber> {
    return await this.signer.getGasPrice()
  }

  async getMarketMaxFeePerGas (): Promise<BigNumber> {
    const { maxFeePerGas } = await this.getGasFeeData()
    return maxFeePerGas! // eslint-disable-line
  }

  async getMarketMaxPriorityFeePerGas (): Promise<BigNumber> {
    const isMainnet = typeof this._is1559Supported === 'boolean' && this._is1559Supported && this.chainSlug === Chain.Ethereum
    if (isMainnet) {
      try {
        const baseUrl = 'https://api.blocknative.com/gasprices/blockprices?confidenceLevels='
        const url = baseUrl + this.maxPriorityFeeConfidenceLevel.toString()
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: blocknativeApiKey
          }
        })

        const gasData = await res.json()
        const maxPriorityFeePerGas = gasData.blockPrices[0].estimatedPrices[0].maxPriorityFeePerGas
        return this.parseGwei(maxPriorityFeePerGas)
      } catch (err) {
        this.logger.error(`blocknative priority fee call failed: ${err}`)
      }
    }

    const { maxPriorityFeePerGas } = await this.getGasFeeData()
    return maxPriorityFeePerGas! // eslint-disable-line
  }

  getMaxGasPrice () {
    return this.parseGwei(this.maxGasPriceGwei)
  }

  getMinPriorityFeePerGas () {
    return this.parseGwei(this.minPriorityFeePerGas)
  }

  getPriorityFeePerGasCap () {
    return this.parseGwei(this.priorityFeePerGasCap)
  }

  async getBumpedGasPrice (multiplier: number = this.gasPriceMultiplier): Promise<BigNumber> {
    const marketGasPrice = await this.getMarketGasPrice()
    if (!this.isChainGasFeeBumpable()) {
      return marketGasPrice
    }
    const prevGasPrice = this.gasPrice ?? marketGasPrice
    const bumpedGasPrice = getBumpedGasPrice(prevGasPrice, multiplier)
    if (!this.compareMarketGasPrice) {
      return bumpedGasPrice
    }
    return BNMax(marketGasPrice, bumpedGasPrice)
  }

  async getBumpedMaxPriorityFeePerGas (multiplier: number = this.gasPriceMultiplier): Promise<BigNumber> {
    const marketMaxPriorityFeePerGas = await this.getMarketMaxPriorityFeePerGas()
    if (!this.isChainGasFeeBumpable()) {
      return marketMaxPriorityFeePerGas
    }
    const prevMaxPriorityFeePerGas = this.maxPriorityFeePerGas ?? marketMaxPriorityFeePerGas
    const minPriorityFeePerGas = this.getMinPriorityFeePerGas()
    this.logger.debug(`getting bumped maxPriorityFeePerGas. this.maxPriorityFeePerGas: ${this.maxPriorityFeePerGas?.toString()}, marketMaxPriorityFeePerGas: ${marketMaxPriorityFeePerGas.toString()}`)
    let bumpedMaxPriorityFeePerGas = getBumpedBN(prevMaxPriorityFeePerGas, multiplier)
    bumpedMaxPriorityFeePerGas = BNMax(minPriorityFeePerGas, bumpedMaxPriorityFeePerGas)
    if (!this.compareMarketGasPrice) {
      return bumpedMaxPriorityFeePerGas
    }
    return BNMax(marketMaxPriorityFeePerGas, bumpedMaxPriorityFeePerGas)
  }

  async getBumpedGasFeeData (multiplier: number = this.gasPriceMultiplier): Promise<Partial<GasFeeData>> {
    const use1559 = await this.is1559Supported() && !this.gasPrice && this.type !== 0

    if (use1559) {
      let [maxFeePerGas, maxPriorityFeePerGas, currentBaseFeePerGas] = await Promise.all([
        this.getMarketMaxFeePerGas(),
        this.getBumpedMaxPriorityFeePerGas(multiplier),
        this.getCurrentBaseFeePerGas()
      ])
      maxFeePerGas = maxFeePerGas.add(maxPriorityFeePerGas)

      const maxGasPrice = this.getMaxGasPrice()
      if (currentBaseFeePerGas && maxFeePerGas.lte(currentBaseFeePerGas)) {
        maxFeePerGas = currentBaseFeePerGas.mul(2)
      }
      maxFeePerGas = BNMin(maxFeePerGas, maxGasPrice)

      return {
        gasPrice: undefined,
        maxFeePerGas,
        maxPriorityFeePerGas
      }
    }

    return {
      gasPrice: await this.getBumpedGasPrice(multiplier),
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined
    }
  }

  clampMaxGasFeeData (gasFeeData: Partial<GasFeeData>): Partial<GasFeeData> {
    if (gasFeeData.gasPrice != null) {
      const maxGasPrice = this.getMaxGasPrice()
      return {
        gasPrice: BNMin(gasFeeData.gasPrice, maxGasPrice)
      }
    }

    const priorityFeePerGasCap = this.getPriorityFeePerGasCap()
    return {
      maxFeePerGas: BNMin(gasFeeData.maxFeePerGas!, this.getMaxGasPrice()),
      maxPriorityFeePerGas: BNMin(gasFeeData.maxPriorityFeePerGas!, priorityFeePerGasCap) // eslint-disable-line
    }
  }

  async getCurrentBaseFeePerGas (): Promise<BigNumber | null> {
    const { baseFeePerGas } = await this.signer.provider!.getBlock('latest')
    return baseFeePerGas ?? null
  }

  getBoostCount (): number {
    return this.boostIndex
  }

  getRebroadcastCount (): number {
    return this.rebroadcastIndex
  }

  setOptions (options: Partial<Options> = {}): void {
    if (options.pollMs) {
      this.pollMs = options.pollMs
    }
    if (options.timeTilBoostMs) {
      this.timeTilBoostMs = options.timeTilBoostMs
    }
    if (options.gasPriceMultiplier) {
      if (options.gasPriceMultiplier !== 1 && options.gasPriceMultiplier < this.minMultiplier) {
        throw new Error(`multiplier must be greater than ${this.minMultiplier}`)
      }
      this.gasPriceMultiplier = options.gasPriceMultiplier
      this.initialTxGasPriceMultiplier = options.gasPriceMultiplier
    }
    if (options.initialTxGasPriceMultiplier) {
      if (options.initialTxGasPriceMultiplier < 1) {
        throw new Error('initial tx multiplier must be greater than or equal to 1')
      }
      this.initialTxGasPriceMultiplier = options.initialTxGasPriceMultiplier
    }
    if (options.maxGasPriceGwei) {
      this.maxGasPriceGwei = options.maxGasPriceGwei
    }
    if (options.minPriorityFeePerGas) {
      this.minPriorityFeePerGas = options.minPriorityFeePerGas
    }
    if (options.priorityFeePerGasCap) {
      this.priorityFeePerGasCap = options.priorityFeePerGasCap
    }
    if (typeof options.compareMarketGasPrice === 'boolean') {
      this.compareMarketGasPrice = options.compareMarketGasPrice
    }
    if (options.reorgWaitConfirmations) {
      this.reorgWaitConfirmations = options.reorgWaitConfirmations
    }
    if (options.maxPriorityFeeConfidenceLevel) {
      this.maxPriorityFeeConfidenceLevel = options.maxPriorityFeeConfidenceLevel
    }
  }

  async wait (): Promise<providers.TransactionReceipt> {
    this.logger.debug(`wait() called, tx: ${this.hash}`)
    this.logger.debug(`wait() called, txHash: ${this.txHash}`)
    this.logger.debug(`wait() called, inFlightItems: ${JSON.stringify(this.inflightItems)}`)
    if (this.txHash) {
      return await this.getReceipt(this.txHash)
    }
    for (const { hash } of this.inflightItems) {
      this.getReceipt(hash!)
        .then(async (receipt: providers.TransactionReceipt) => this.handleConfirmation(hash!, receipt))
    }
    return await new Promise((resolve, reject) => {
      this
        .on(State.Confirmed, (tx) => {
          this.logger.debug('state confirmed')
          resolve(tx)
        })
        .on(State.Error, (err) => {
          reject(err)
        })
      const listeners = (this as any)._events
      this.logger.debug(`subscribers: "${State.Confirmed}": ${listeners?.[State.Confirmed]?.length}, "${State.Error}": ${listeners?.[State.Error]?.length}`)
    })
  }

  hasInflightItems (): boolean {
    return this.inflightItems.length > 0
  }

  getInflightItems (): InflightItem[] {
    return this.inflightItems
  }

  getLatestInflightItem (): InflightItem | undefined {
    if (this.hasInflightItems()) {
      return this.inflightItems[this.inflightItems.length - 1]
    }
  }

  private async handleConfirmation (txHash: string, receipt: providers.TransactionReceipt) {
    if (this.confirmations) {
      return
    }
    this.confirmations = 1
    this.txHash = txHash
    this.clearInflightTxs()
    const tx = await this.signer.provider!.getTransaction(txHash) // eslint-disable-line
    this.gasPrice = tx.gasPrice!
    this.maxFeePerGas = tx.maxFeePerGas!
    this.maxPriorityFeePerGas = tx.maxPriorityFeePerGas!
    this.receipt = receipt
    this.emit(State.Confirmed, receipt)
    this.logger.debug(`confirmed tx: ${tx.hash}, boostIndex: ${this.boostIndex}, rebroadcastIndex: ${this.rebroadcastIndex}, nonce: ${this.nonce.toString()}, ${this.getGasFeeDataAsString()}`)
    this.watchForReorg()
  }

  private async handleMaxRebroadcastIndexReached () {
    this.maxRebroadcastIndexReached = true
    this.clearInflightTxs()
    this.emit(State.Error)
    const errMsg = 'max rebroadcast index reached. cannot rebroadcast.'
    this.notifier.error(errMsg, { channel: gasBoostErrorSlackChannel })
    this.logger.error(errMsg)
  }

  private async getReceipt (txHash: string) {
    return await this.signer.provider!.waitForTransaction(txHash) // eslint-disable-line
  }

  private async startPoller () {
    if (this.started) {
      return
    }
    this.started = true
    while (true) {
      if (this.confirmations || this.maxRebroadcastIndexReached) {
        this.logger.debug(`ending poller. confirmations: ${this.confirmations}, maxRebroadcastIndexReached: ${this.maxRebroadcastIndexReached}`)
        break
      }
      try {
        await this.poll()
      } catch (err) {
        this._emitError(err)
        this.logger.error(`ending poller. ${err.message}`)
        if (err instanceof NonceTooLowError || err instanceof EstimateGasError || err instanceof KmsSignerError) {
          this.logger.error('ending poller. breaking.')
          break
        }
      }
      await wait(this.pollMs)
    }
  }

  private async poll () {
    for (const item of this.inflightItems) {
      await this.handleInflightTx(item)
    }
  }

  private async handleInflightTx (item: InflightItem) {
    if (this.shouldBoost(item)) {
      return this.boost(item)
    }
    if (this.shouldRebroadcastLatestTx()) {
      try {
        await this.rebroadcastLatestTx()
      } catch (err) {
        this.logger.error('rebroadcastLatestTx error:', err)
      }
    }
  }

  private shouldBoost (item: InflightItem) {
    const timeOk = item.sentAt < (Date.now() - this.timeTilBoostMs)
    const isConfirmed = this.confirmations
    const isMaxGasPriceReached = this.maxGasPriceReached
    return timeOk && !isConfirmed && !isMaxGasPriceReached && !item.boosted
  }

  private shouldRebroadcastLatestTx () {
    const item = this.getLatestInflightItem()
    if (!item) {
      return false
    }
    const timeOk = item.sentAt < (Date.now() - this.timeTilBoostMs)
    const isLatestItem = item === this.getLatestInflightItem()
    return timeOk && isLatestItem && this.maxGasPriceReached
  }

  private async boost (item: InflightItem) {
    this.logger.debug(`attempting boost with boost index ${this.boostIndex}`)
    const gasFeeData = await this.getBumpedGasFeeData()
    const maxGasPrice = this.getMaxGasPrice()
    const priorityFeePerGasCap = this.getPriorityFeePerGasCap()

    // don't boost if suggested gas is over max
    const isGasPriceMaxReached = gasFeeData.gasPrice?.gt(maxGasPrice)
    const isMaxFeePerGasReached = gasFeeData.maxFeePerGas?.gt(maxGasPrice)
    const isMaxPriorityFeePerGasReached = gasFeeData.maxPriorityFeePerGas?.gt(priorityFeePerGasCap)
    let isMaxReached = isGasPriceMaxReached ?? isMaxFeePerGasReached
    this.logger.debug(`isGasPriceMaxReached: ${isGasPriceMaxReached}, isMaxFeePerGasReached: ${isMaxFeePerGasReached}, isMaxPriorityFeePerGasReached: ${isMaxPriorityFeePerGasReached}`)

    // clamp maxPriorityFeePerGas to max allowed if it exceeds max and
    // gasPrice or maxFeePerGas are still under max
    if (!isMaxReached && isMaxPriorityFeePerGasReached && this.maxPriorityFeePerGas) {
      const clampedGasFeeData = this.clampMaxGasFeeData(gasFeeData)
      this.logger.debug(`checking if maxPriorityFeePerGas is max. clamping with clampedGasFeeData: ${JSON.stringify(clampedGasFeeData)}`)
      gasFeeData.maxPriorityFeePerGas = clampedGasFeeData.maxPriorityFeePerGas

      // if last used maxPriorityFeePerGas already equals max allowed then
      // it cannot be boosted
      if (gasFeeData.maxPriorityFeePerGas?.eq(this.maxPriorityFeePerGas)) {
        isMaxReached = true
      }
    }
    if (isMaxReached) {
      if (!this.maxGasPriceReached) {
        const warnMsg = `max gas price reached. boostedGasFee: (${this.getGasFeeDataAsString(gasFeeData)}, maxGasFee: (gasPrice: ${maxGasPrice}, maxPriorityFeePerGas: ${priorityFeePerGasCap}). cannot boost`
        this.notifier.warn(warnMsg, { channel: gasBoostWarnSlackChannel })
        this.logger.warn(warnMsg)
        this.emit(State.MaxGasPriceReached, gasFeeData.gasPrice, this.boostIndex)
        this.maxGasPriceReached = true
      }
      return
    }
    const tx = await this._sendTransaction(gasFeeData)

    this.setGasProperties(tx)
    this.boostIndex++
    this.track(tx)
    this.emit(State.Boosted, tx, this.boostIndex)
  }

  private async _sendTransaction (gasFeeData: Partial<GasFeeData>): Promise<providers.TransactionResponse> {
    const maxRetries = 10
    let i = 0
    while (true) {
      i++
      try {
        this.logger.debug(`tx index ${i}: sending`)
        if (i > 1) {
          this.logger.debug(`tx index ${i}: retrieving gasFeeData`)
          gasFeeData = await this.getBumpedGasFeeData(this.gasPriceMultiplier * i)
        }

        const payload: providers.TransactionRequest = {
          type: this.type,
          to: this.to,
          data: this.data,
          value: this.value,
          nonce: this.nonce,
          gasLimit: this.gasLimit,
          chainId: this.chainId
        }

        if (gasFeeData.gasPrice != null) {
          payload.gasPrice = gasFeeData.gasPrice
        } else {
          payload.maxFeePerGas = gasFeeData.maxFeePerGas
          payload.maxPriorityFeePerGas = gasFeeData.maxPriorityFeePerGas
        }

        if (i === 1) {
          const timeLimitMs = 60 * 1000
          let shouldCheck = true
          if (enoughFundsCheckCache[this.chainSlug]) {
            shouldCheck = enoughFundsCheckCache[this.chainSlug] + timeLimitMs < Date.now()
          }
          if (shouldCheck) {
            this.logger.debug(`tx index ${i}: checking for enough funds`)
            const _timeId = `GasBoostTransaction _sendTransaction checkHasEnoughFunds elapsed ${this.logId} ${i} `
            console.time(_timeId)
            enoughFundsCheckCache[this.chainSlug] = Date.now()
            await this.checkHasEnoughFunds(payload, gasFeeData)
            console.timeEnd(_timeId)
          }
        }

        this.logger.debug(`tx index ${i}: sending transaction`)

        const _timeId = `GasBoostTransaction signer.sendTransaction elapsed ${this.logId} ${i} `
        // await here is intentional to catch error below
        console.time(_timeId)
        const tx = await this.signer.sendTransaction(payload)
        console.timeEnd(_timeId)

        this.logger.debug(`tx index ${i} completed`)
        return tx
      } catch (err: any) {
        this.logger.debug(`tx index ${i} error: ${err.message}`)

        const {
          nonceTooLow,
          estimateGasFailed,
          isAlreadyKnown,
          isFeeTooLow,
          serverError,
          kmsSignerError
        } = this.parseErrorString(err.message)

        // nonceTooLow error checks must be done first since the following errors can be true while nonce is too low
        if (nonceTooLow) {
          this.logger.error(`nonce ${this.nonce} too low`)
          throw new NonceTooLowError('NonceTooLow')
        } else if (estimateGasFailed && !serverError) {
          this.logger.error('estimateGas failed')
          throw new EstimateGasError('EstimateGasError')
        }

        if (kmsSignerError) {
          throw new KmsSignerError('KmsSignerError')
        }

        const shouldRetry = (isAlreadyKnown || isFeeTooLow || serverError) && i < maxRetries
        if (shouldRetry) {
          continue
        }
        if (estimateGasFailed) {
          throw new EstimateGasError('EstimateGasError')
        }
        throw err
      }
    }
  }

  private async checkHasEnoughFunds (payload: providers.TransactionRequest, gasFeeData: Partial<GasFeeData>) {
    let gasLimit
    let ethBalance

    const _timeId1 = `GasBoostTransaction checkHasEnoughFunds estimateGas elapsed ${this.logId} `
    console.time(_timeId1)
    try {
      gasLimit = await this.signer.estimateGas(payload)
    } catch (err) {
      throw new Error(`checkHasEnoughFunds estimateGas failed. Error: ${err.message}`)
    }
    console.timeEnd(_timeId1)

    const _timeId2 = `GasBoostTransaction checkHasEnoughFunds getBalance elapsed ${this.logId} `
    console.time(_timeId2)
    try {
      ethBalance = await this.signer.getBalance()
    } catch (err) {
      throw new Error(`checkHasEnoughFunds getBalance failed. Error: ${err.message}`)
    }
    console.timeEnd(_timeId2)

    const gasPrice = gasFeeData.gasPrice || gasFeeData.maxFeePerGas // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing
    const gasCost = gasLimit.mul(gasPrice!) // eslint-disable-line
    const warnEthBalance = parseUnits((this.warnEthBalance || 0).toString(), 18)
    const formattedGasCost = formatUnits(gasCost, 18)
    const formattedEthBalance = formatUnits(ethBalance, 18)
    if (ethBalance.lt(gasCost)) {
      const errMsg = `insufficient ETH funds to cover gas cost. Need ${formattedGasCost}, have ${formattedEthBalance}`
      this.notifier.error(errMsg, { channel: gasBoostErrorSlackChannel })
      this.logger.error(errMsg)
      throw new Error(errMsg)
    }
    if (ethBalance.lt(warnEthBalance)) {
      const warnMsg = `ETH balance is running low. Have ${formattedEthBalance}`
      this.logger.warn(warnMsg)
      this.notifier.warn(warnMsg, { channel: gasBoostWarnSlackChannel })
    }
  }

  private track (tx: providers.TransactionResponse) {
    this.logger.debug('tracking')
    const prevItem = this.getLatestInflightItem()
    if (prevItem) {
      this.logger.debug(`tracking: prevItem ${JSON.stringify(prevItem)}`)
      prevItem.boosted = true
      this.logger.debug(`tracking boosted tx: ${tx.hash}, previous tx: ${prevItem.hash}, boostIndex: ${this.boostIndex}, rebroadcastIndex: ${this.rebroadcastIndex}, nonce: ${this.nonce.toString()}, ${this.getGasFeeDataAsString()}`)
    } else {
      this.logger.debug(`tracking new tx: ${tx.hash}, nonce: ${this.nonce.toString()}, ${this.getGasFeeDataAsString()}`)
    }
    this.inflightItems.push({
      boosted: false,
      hash: tx.hash,
      sentAt: Date.now()
    })
    this.logger.debug(`tracking: inflightItems${JSON.stringify(this.inflightItems)}`)
    tx.wait().then((receipt: providers.TransactionReceipt) => {
      this.logger.debug(`tracking: wait completed. tx hash ${tx.hash}`)
      this.handleConfirmation(tx.hash, receipt)
    })
      .catch((err: Error) => {
        const isReplacedError = /TRANSACTION_REPLACED/i.test(err.message)
        if (!isReplacedError) {
          this._emitError(err)
        }
      })
    this.startPoller()
  }

  private clearInflightTxs () {
    this.inflightItems = []
  }

  private parseGwei (value: number) {
    return parseUnits(value.toString(), 9)
  }

  private formatGwei (value: BigNumber) {
    return formatUnits(value.toString(), 9)
  }

  private getGasFeeDataAsString (gasFeeData: Partial<GasFeeData> = this) {
    const format = (value?: BigNumber) => (value != null) ? this.formatGwei(value) : null
    const { gasPrice, maxFeePerGas, maxPriorityFeePerGas } = gasFeeData
    return `gasPrice: ${format(gasPrice)}, maxFeePerGas: ${format(maxFeePerGas)}, maxPriorityFeePerGas: ${format(maxPriorityFeePerGas)}`
  }

  async is1559Supported (): Promise<boolean> {
    if (typeof this._is1559Supported === 'boolean') {
      return this._is1559Supported
    }
    const { maxFeePerGas, maxPriorityFeePerGas } = await this.getGasFeeData()
    const isSupported = !!((maxFeePerGas != null) && (maxPriorityFeePerGas != null))
    this._is1559Supported = isSupported
    return isSupported
  }

  isChainGasFeeBumpable () {
    // Optimism gasPrice must be constant; shouldn't be bumped
    if (this.chainSlug === Chain.Optimism) {
      return false
    }

    return true
  }

  // explainer: https://stackoverflow.com/q/35185749/1439168
  private _emitError (err: Error) {
    if (this.listeners(State.Error).length > 0) {
      this.emit(State.Error, err)
    }
  }

  private parseErrorString (errMessage: string) {
    const nonceTooLow = /(nonce.*too low|same nonce|already been used|NONCE_EXPIRED|OldNonce|invalid transaction nonce)/i.test(errMessage)
    const estimateGasFailed = /eth_estimateGas/i.test(errMessage)
    const isAlreadyKnown = /(AlreadyKnown|already known)/i.test(errMessage) // tx is already in mempool
    const isFeeTooLow = /FeeTooLowToCompete|transaction underpriced/i.test(errMessage)
    const serverError = /SERVER_ERROR/g.test(errMessage)
    const kmsSignerError = /Error signing message/g.test(errMessage)
    return {
      nonceTooLow,
      estimateGasFailed,
      isAlreadyKnown,
      isFeeTooLow,
      serverError,
      kmsSignerError
    }
  }

  private async watchForReorg () {
    this.logger.debug('watchForReorg started')
    while (true) {
      try {
        const confirmedBlockNumber = this.receipt!.blockNumber
        const waitConfirmationsBlockNumber = confirmedBlockNumber + this.reorgWaitConfirmations
        const { number: headBlockNumber } = await this.signer.provider!.getBlock('latest')
        if (headBlockNumber >= waitConfirmationsBlockNumber) {
          this.logger.debug('checking for tx receipt to see if reorg occurred')
          const receipt = await this.signer.provider!.getTransactionReceipt(this.hash)
          if (receipt) {
            this.logger.debug(`no reorg; receipt found after waiting reorgWaitConfirmations (${this.reorgWaitConfirmations})`)
          } else {
            this.logger.debug(`no transaction receipt found after waiting reorgWaitConfirmations (${this.reorgWaitConfirmations})`)
            this.emit(State.Reorg, this.hash)
            this.rebroadcastInitialTx()
          }
          break
        }
      } catch (err) {
        this.logger.error('watForReorg error:', err)
      }
      await wait(this.pollMs)
    }
  }

  private async rebroadcastInitialTx () {
    this.reset()
    this.logger.debug('attempting to rebroadcast initial transaction')
    return this.send()
  }

  private async rebroadcastLatestTx () {
    this.logger.debug(`attempting to rebroadcast latest transaction with index ${this.rebroadcastIndex}`)
    const payload: providers.TransactionRequest = {
      type: this.type,
      to: this.to,
      data: this.data,
      value: this.value,
      nonce: this.nonce,
      gasLimit: this.gasLimit,
      gasPrice: this.gasPrice,
      maxFeePerGas: this.maxFeePerGas,
      maxPriorityFeePerGas: this.maxPriorityFeePerGas,
      chainId: this.chainId
    }

    // Update state before the tx is sent in case of error
    const item = this.getLatestInflightItem()
    item!.sentAt = Date.now()
    this.rebroadcastIndex++

    const isMaxReached = this.rebroadcastIndex > this.maxRebroadcastIndex
    if (isMaxReached) {
      await this.handleMaxRebroadcastIndexReached()
      return
    }

    const tx = await this.signer.sendTransaction(payload)
    this.logger.debug(`rebroadcasted transaction, tx hash: ${tx.hash}`)

    return tx
  }

  private reset () {
    this.logger.debug('resetting tx state to original tx params')
    this.started = false
    this.boostIndex = 0
    this.confirmations = 0
    this.txHash = undefined
    this.receipt = undefined
    this.gasPrice = undefined
    this.maxFeePerGas = undefined
    this.maxPriorityFeePerGas = undefined
    this.clearInflightTxs()
    this.setOwnTxParams(this.originalTxParams)
  }
}

export default GasBoostTransaction
