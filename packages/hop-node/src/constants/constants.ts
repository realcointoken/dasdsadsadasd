import { chains } from '@hop-protocol/core/metadata'

export enum Network {
  Mainnet = 'mainnet',
  Staging = 'staging',
  Goerli = 'goerli',
  Kovan = 'kovan',
}

// TODO: read from core
export enum Chain {
  Ethereum = 'ethereum',
  Optimism = 'optimism',
  Arbitrum = 'arbitrum',
  Polygon = 'polygon',
  Gnosis = 'gnosis',
  Nova = 'nova',
  ZkSync = 'zksync',
  Linea = 'linea',
  ScrollZk = 'scrollzk',
  Base = 'base'
}

// TODO: read from core
export enum Token {
  USDC = 'USDC',
  USDT = 'USDT',
  DAI = 'DAI',
  ETH = 'ETH',
  MATIC = 'MATIC',
  HOP = 'HOP',
  SNX = 'SNX',
}

export enum NativeChainToken {
  ETH = 'ETH',
  XDAI = 'XDAI',
  MATIC = 'MATIC'
}

const nativeChainTokens: Record<string, string> = {}
for (const chain in chains) {
  nativeChainTokens[chain] = (chains as any)[chain].nativeTokenSymbol
}

export { nativeChainTokens }

export const AvgBlockTimeSeconds: Record<string, number> = {
  [Chain.Ethereum]: 12,
  [Chain.Polygon]: 2,
  [Chain.Gnosis]: 5
}

export const SettlementGasLimitPerTx: Record<string, number> = {
  ethereum: 5141,
  polygon: 5933,
  gnosis: 3218,
  optimism: 8545,
  arbitrum: 19843,
  nova: 19843,
  zksync: 10000, // TODO
  linea: 10000, // TODO
  scrollzk: 10000, // TODO
  base: 10000 // TODO
}

export const DefaultBatchBlocks = 10000

export const TenSecondsMs = 10 * 1000
export const TenMinutesMs = 10 * 60 * 1000
export const OneHourSeconds = 60 * 60
export const OneHourMs = OneHourSeconds * 1000
export const OneDaySeconds = 24 * 60 * 60
export const OneDayMs = OneDaySeconds * 1000
export const OneWeekSeconds = 7 * 24 * 60 * 60
export const OneWeekMs = OneWeekSeconds * 1000

export const TotalBlocks = {
  Ethereum: Math.floor(OneWeekSeconds / AvgBlockTimeSeconds[Chain.Ethereum]),
  Polygon: Math.floor(OneWeekSeconds / AvgBlockTimeSeconds[Chain.Polygon]),
  Gnosis: Math.floor(OneWeekSeconds / AvgBlockTimeSeconds[Chain.Gnosis])
}

export const RootSetSettleDelayMs = 5 * 60 * 1000
export const ChallengePeriodMs = 24 * OneHourMs

export const MaxInt32 = 2147483647

export enum TxError {
  CallException = 'CALL_EXCEPTION',
  BonderFeeTooLow = 'BONDER_FEE_TOO_LOW',
  RelayerFeeTooLow = 'RELAYER_FEE_TOO_LOW',
  NotEnoughLiquidity = 'NOT_ENOUGH_LIQUIDITY',
  RedundantRpcOutOfSync = 'REDUNDANT_RPC_OUT_OF_SYNC',
}

export const MaxPriorityFeeConfidenceLevel = 95
export const InitialTxGasPriceMultiplier = 1
export const MaxGasPriceMultiplier = 1.25
export const MinPriorityFeePerGas = 0.1
export const PriorityFeePerGasCap = 20
export const MinPolygonGasPrice = 60_000_000_000
export const MinGnosisGasPrice = 5_000_000_000

export enum TokenIndex {
  CanonicalToken = 0,
  HopBridgeToken = 1,
}

export enum GasCostTransactionType {
  BondWithdrawal = 'bondWithdrawal',
  BondWithdrawalAndAttemptSwap = 'bondWithdrawalAndAttemptSwap',
  Relay = 'relay'
}

export const RelayableChains: string[] = [
  Chain.Arbitrum,
  Chain.Nova
]

export const MaxDeadline: number = 9999999999

export const ChainHasFinalizationTag: Record<string, boolean> = {
  ethereum: true
}

export const stableCoins = new Set(['USDC', 'USDT', 'DAI', 'sUSD'])
export const BondTransferRootDelayBufferSeconds = 5 * 60
export const MaxReorgCheckBackoffIndex = 2 // 120 + 240 + 480 = 840 seconds, 14 minutes
