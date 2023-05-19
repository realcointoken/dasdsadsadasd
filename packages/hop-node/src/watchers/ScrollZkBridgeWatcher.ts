import BaseWatcher from './classes/BaseWatcher'
import Logger from 'src/logger'
import { L1_Bridge as L1BridgeContract } from '@hop-protocol/core/contracts/generated/L1_Bridge'
import { L2_Bridge as L2BridgeContract } from '@hop-protocol/core/contracts/generated/L2_Bridge'

type Config = {
  chainSlug: string
  tokenSymbol: string
  bridgeContract?: L1BridgeContract | L2BridgeContract
  dryMode?: boolean
}

class ScrollZkBridgeWatcher extends BaseWatcher {
  constructor (config: Config) {
    super({
      chainSlug: config.chainSlug,
      tokenSymbol: config.tokenSymbol,
      logColor: 'yellow',
      bridgeContract: config.bridgeContract,
      dryMode: config.dryMode
    })
  }

  async handleCommitTxHash (commitTxHash: string, transferRootId: string, logger: Logger) {
    // L2->L1 messages on Scroll zkEMV are automatically executed by the operator so no need to execute transactions on L1.
  }

  async relayXDomainMessage (commitTxHash: string): Promise<void> {
    // noop
  }
}

export default ScrollZkBridgeWatcher
