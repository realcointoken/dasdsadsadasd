import '../moduleAlias'
import BaseWatcher from './classes/BaseWatcher'
import L1Bridge from './classes/L1Bridge'
import { ChallengeableTransferRoot } from 'src/db/TransferRootsDb'
import { L1_Bridge as L1BridgeContract } from '@hop-protocol/core/contracts/generated/L1_Bridge'
import { L2_Bridge as L2BridgeContract } from '@hop-protocol/core/contracts/generated/L2_Bridge'
import { Notifier } from 'src/notifier'
import { hostname } from 'src/config'

type Config = {
  chainSlug: string
  bridgeContract: L1BridgeContract | L2BridgeContract
  tokenSymbol: string
  dryMode?: boolean
}

class ChallengeWatcher extends BaseWatcher {
  siblingWatchers: { [chainId: string]: ChallengeWatcher }

  constructor (config: Config) {
    super({
      chainSlug: config.chainSlug,
      tokenSymbol: config.tokenSymbol,
      bridgeContract: config.bridgeContract,
      logColor: 'red',
      dryMode: config.dryMode
    })

    this.notifier = new Notifier(`watcher: ChallengeWatcher, host: ${hostname}`)
  }

  async pollHandler () {
    if (!this.isL1) {
      return
    }
    await this.checkChallengeableTransferRootFromDb()
  }

  async checkChallengeableTransferRootFromDb () {
    const dbTransferRoots = await this.db.transferRoots.getChallengeableTransferRoots(await this.getFilterRoute())
    if (!dbTransferRoots.length) {
      return
    }

    this.logger.info(
        `checking ${dbTransferRoots.length} challengeable root db items`
    )

    for (const dbTransferRoot of dbTransferRoots) {
      const { transferRootId } = dbTransferRoot
      await this.checkChallengeableTransferRoot(transferRootId)
    }
  }

  async checkChallengeableTransferRoot (transferRootId: string) {
    const logger = this.logger.create({ root: transferRootId })

    const { transferRootHash, totalAmount } = await this.db.transferRoots.getByTransferRootId(transferRootId) as ChallengeableTransferRoot
    logger.debug('Challenging transfer root', transferRootId)
    logger.debug('transferRootHash:', transferRootHash)
    logger.debug('totalAmount:', this.bridge.formatUnits(totalAmount))
    logger.debug('transferRootId:', transferRootId)

    const dbTransferRoot = await this.db.transferRoots.getByTransferRootId(
      transferRootId
    )

    const { bondTxHash } = dbTransferRoot
    if (!bondTxHash) {
      throw new Error('expected bondTxHash')
    }

    const l1Bridge = this.bridge as L1Bridge
    const tx = await l1Bridge.getTransaction(bondTxHash)
    if (!tx) {
      throw new Error('expected transaction object')
    }

    const { destinationChainId } = await l1Bridge.decodeBondTransferRootCalldata(tx.data)
    const isTransferRootIdConfirmed = await l1Bridge.isTransferRootIdConfirmed(
      destinationChainId, transferRootId
    )
    if (isTransferRootIdConfirmed) {
      logger.info('rootHash is already confirmed on L1')
      await this.db.transferRoots.update(transferRootId, {
        confirmed: true
      })
      return
    }

    const bond = await l1Bridge.getTransferBond(transferRootId)
    const isChallenged = bond.challengeStartTime.toNumber() > 0
    if (isChallenged) {
      logger.info('challenge already started')
      await this.db.transferRoots.update(transferRootId, {
        challenged: true
      })
      return
    }

    // Do not set emergencyDryMode here. This tx should always be fired off if needed.
    if (this.dryMode) {
      logger.warn(`dry: ${this.dryMode}, skipping challengeTransferRootBond`)
      return
    }

    const challengeMsg = `TransferRoot should be challenged! Root id: ${transferRootId}. Root hash: ${transferRootHash} Total amt: ${totalAmount}.`
    logger.debug(challengeMsg)
    await this.notifier.warn(challengeMsg)
    await this.db.transferRoots.update(transferRootId, {
      challenged: true
    })
  }
}

export default ChallengeWatcher
