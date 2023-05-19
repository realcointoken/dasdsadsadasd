export enum ChainSlug {
  ethereum = 'ethereum',
  polygon = 'polygon',
  gnosis = 'gnosis',
  optimism = 'optimism',
  arbitrum = 'arbitrum',
  nova = 'nova',
  zkSync = 'zksync',
  linea = 'linea',
  scrollzk = 'scrollzk',
  base = 'base'
}

export enum AssetSymbol {
  USDC = 'USDC',
  USDT = 'USDT',
  DAI = 'DAI',
  MATIC = 'MATIC',
  ETH = 'ETH',
  WBTC = 'WBTC',
  HOP = 'HOP',
  SNX = 'SNX',
  sUSD = 'sUSD',
  sBTC = 'sBTC',
  sETH = 'sETH',
  rETH = 'rETH',
  UNI = 'UNI'
}

export type Bps = {
  [key in ChainSlug]: number
}

export type Fees = {
  [key in AssetSymbol]: Partial<Bps>
}

type RelayerFee = {
  [key in ChainSlug]: boolean
}

export type Config = {
  bonderFeeBps: Partial<Fees>
  destinationFeeGasPriceMultiplier: number
  relayerFeeEnabled: Partial<RelayerFee>
}
