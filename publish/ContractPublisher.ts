/* eslint-disable @typescript-eslint/no-non-null-assertion */
import bre, { ethers } from "@nomiclabs/buidler"
import { TASK_COMPILE } from "@nomiclabs/buidler/builtin-tasks/task-names"
import { BigNumber } from "ethers"
import PerpRewardVestingArtifact from "../build/contracts/PerpRewardVesting.json"
import { SRC_DIR } from "../constants"
import { ExternalContracts, Layer } from "../scripts/common"
import { flatten } from "../scripts/flatten"
import {
    Amm,
    AmmReader,
    ChainlinkL1,
    ClearingHouse,
    ClearingHouseViewer,
    ClientBridge,
    InsuranceFund,
    L2PriceFeed,
    MetaTxGateway,
    PerpRewardVesting,
    RootBridge,
} from "../types/ethers"
import { ContractWrapperFactory } from "./contract/ContractWrapperFactory"
import { DEFAULT_DIGITS, DeployConfig, makeAmmConfig, PriceFeedKey } from "./contract/DeployConfig"
import { DeployTask, getImplementation, makeAmmDeployBatch } from "./contract/DeployUtil"
import { AmmInstanceName, ContractInstanceName, ContractName } from "./ContractName"
import { OzContractDeployer } from "./OzContractDeployer"
import { SettingsDao } from "./SettingsDao"
import { SystemMetadataDao } from "./SystemMetadataDao"

/* eslint-disable no-console */
export class ContractPublisher {
    readonly externalContract: ExternalContracts
    readonly factory: ContractWrapperFactory
    readonly deployConfig: DeployConfig
    protected taskBatchesMap: Record<Layer, DeployTask[][]> = {
        layer1: [],
        layer2: [],
    }

    constructor(
        readonly layerType: Layer,
        readonly settingsDao: SettingsDao,
        readonly systemMetadataDao: SystemMetadataDao,
    ) {
        this.externalContract = settingsDao.getExternalContracts(layerType)
        this.deployConfig = new DeployConfig(settingsDao.stage)
        this.factory = new ContractWrapperFactory(layerType, systemMetadataDao, this.deployConfig.confirmations)

        this.taskBatchesMap.layer1 = [
            // batch 0
            [
                async (): Promise<void> => {
                    console.log("deploy root bridge")
                    await this.factory
                        .create<RootBridge>(ContractName.RootBridge)
                        .deployUpgradableContract(
                            this.externalContract.ambBridgeOnEth!,
                            this.externalContract.multiTokenMediatorOnEth!,
                        )
                },
            ],
            // batch 1
            [
                async (): Promise<void> => {
                    console.log("deploy chainlink price feed on layer 1...")
                    const l2PriceFeedOnXdai = this.systemMetadataDao.getContractMetadata(
                        "layer2",
                        ContractName.L2PriceFeed,
                    ).address
                    const rootBridgeContract = this.factory.create<RootBridge>(ContractName.RootBridge)
                    await this.factory
                        .create<ChainlinkL1>(ContractName.ChainlinkL1)
                        .deployUpgradableContract(rootBridgeContract.address!, l2PriceFeedOnXdai)
                },
                async (): Promise<void> => {
                    console.log("setPriceFeed...")
                    const chainlinkContract = this.factory.create<ChainlinkL1>(ContractName.ChainlinkL1)
                    const rootBridge = await this.factory.create<RootBridge>(ContractName.RootBridge).instance()
                    await (await rootBridge.setPriceFeed(chainlinkContract.address!)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("add BTC aggregator of chainlink price feed on layer 1...")
                    const chainlinkContract = this.factory.create<ChainlinkL1>(ContractName.ChainlinkL1)
                    const chainlink = await chainlinkContract.instance()
                    const address = this.deployConfig.chainlinkMap[PriceFeedKey.BTC]
                    await (
                        await chainlink.addAggregator(
                            ethers.utils.formatBytes32String(PriceFeedKey.BTC.toString()),
                            address,
                        )
                    ).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("add ETH aggregator of chainlink price feed on layer 1...")
                    const chainlinkContract = this.factory.create<ChainlinkL1>(ContractName.ChainlinkL1)
                    const chainlink = await chainlinkContract.instance()
                    const address = this.deployConfig.chainlinkMap[PriceFeedKey.ETH]
                    await (
                        await chainlink.addAggregator(
                            ethers.utils.formatBytes32String(PriceFeedKey.ETH.toString()),
                            address,
                        )
                    ).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.foundationGovernance!
                    console.log(
                        `transferring chainlinkL1's owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const chainlinkL1 = await this.factory.create<ChainlinkL1>(ContractName.ChainlinkL1).instance()
                    await (await chainlinkL1.setOwner(gov)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.foundationGovernance!
                    console.log(
                        `transferring rootBridge's owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const rootBridge = await this.factory.create<RootBridge>(ContractName.RootBridge).instance()
                    await (await rootBridge.setOwner(gov)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    if (this.inSameLayer) {
                        return
                    }
                    const governance = this.externalContract.foundationGovernance!
                    console.log(`${this.layerType} batch ends, transfer proxy admin to ${governance}`)
                    await OzContractDeployer.transferProxyAdminOwnership(governance)
                    console.log(`${this.layerType} contract deployment finished.`)
                },
            ],
            // batch 2
            // deploy PerpRewardVesting - 0 vesting & 12 weeks vesting
            [
                async (): Promise<void> => {
                    console.log("deploy PerpRewardVesting with 0 vesting...")
                    const perpAddr = this.settingsDao.getExternalContracts(this.layerType).perp!
                    await this.factory
                        .create<PerpRewardVesting>(
                            ContractName.PerpRewardVesting,
                            ContractInstanceName.PerpRewardNoVesting,
                        )
                        .deployUpgradableContract(perpAddr, 0)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.rewardGovernance!
                    console.log(
                        `transferring PerpRewardNoVesting's owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const reward = await this.factory
                        .create<PerpRewardVesting>(
                            ContractName.PerpRewardVesting,
                            ContractInstanceName.PerpRewardNoVesting,
                        )
                        .instance()
                    await (await reward.setOwner(gov)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("deploy PerpRewardVesting with 24w vesting...")
                    const perpAddr = this.settingsDao.getExternalContracts(this.layerType).perp!
                    await this.factory
                        .create<PerpRewardVesting>(
                            ContractName.PerpRewardVesting,
                            ContractInstanceName.PerpRewardTwentySixWeeksVesting,
                        )
                        .deployUpgradableContract(perpAddr, this.deployConfig.defaultPerpRewardVestingPeriod)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.rewardGovernance!
                    console.log(
                        `transferring PerpRewardTwentySixWeeksVesting's owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const reward = await this.factory
                        .create<PerpRewardVesting>(
                            ContractName.PerpRewardVesting,
                            ContractInstanceName.PerpRewardTwentySixWeeksVesting,
                        )
                        .instance()
                    await (await reward.setOwner(gov)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log(
                        "call PerpRewardTwentySixWeeksVesting.initialize() on implementation to avoid security issue",
                    )
                    const reward = await this.factory
                        .create<PerpRewardVesting>(
                            ContractName.PerpRewardVesting,
                            ContractInstanceName.PerpRewardTwentySixWeeksVesting,
                        )
                        .instance()
                    const perpAddr = this.settingsDao.getExternalContracts(this.layerType).perp!
                    const proxyAdminAddr = this.settingsDao.getExternalContracts(this.layerType).proxyAdmin!
                    const impAddr = await getImplementation(proxyAdminAddr, reward.address)
                    console.log("implementation: ", impAddr)
                    const imp = await ethers.getContractAt(PerpRewardVestingArtifact.abi, impAddr)
                    const tx = await imp.initialize(perpAddr, this.deployConfig.defaultPerpRewardVestingPeriod)
                    await tx.wait(this.confirmations)
                },
            ],
        ]

        this.taskBatchesMap.layer2 = [
            // batch 0
            [
                async (): Promise<void> => {
                    console.log("deploy metaTxGateway...")
                    const chainId = this.settingsDao.getChainId("layer1")
                    await this.factory
                        .create<MetaTxGateway>(ContractName.MetaTxGateway)
                        .deployUpgradableContract("Perp", "1", chainId)
                },
                async (): Promise<void> => {
                    console.log("deploy clientBridge...")
                    const ambBridgeOnXDai = this.externalContract.ambBridgeOnXDai!
                    const multiTokenMediatorOnXDai = this.externalContract.multiTokenMediatorOnXDai!
                    const metaTxGatewayContract = this.factory.create<MetaTxGateway>(ContractName.MetaTxGateway)
                    await this.factory
                        .create<ClientBridge>(ContractName.ClientBridge)
                        .deployUpgradableContract(
                            ambBridgeOnXDai,
                            multiTokenMediatorOnXDai,
                            metaTxGatewayContract.address!,
                        )
                },
                async (): Promise<void> => {
                    console.log("deploy insuranceFund...")
                    await this.factory.create<InsuranceFund>(ContractName.InsuranceFund).deployUpgradableContract()
                },
                async (): Promise<void> => {
                    console.log("deploy L2PriceFeed")
                    const ambBridgeOnXDaiAddr = this.externalContract.ambBridgeOnXDai!
                    const rootBridgeOnEthAddr = this.systemMetadataDao.getContractMetadata(
                        "layer1",
                        ContractName.RootBridge,
                    ).address
                    await this.factory
                        .create<L2PriceFeed>(ContractName.L2PriceFeed)
                        .deployUpgradableContract(ambBridgeOnXDaiAddr, rootBridgeOnEthAddr)
                },
                async (): Promise<void> => {
                    console.log("deploy clearing house...")
                    const insuranceFundContract = this.factory.create<InsuranceFund>(ContractName.InsuranceFund)
                    const metaTxGatewayContract = this.factory.create<MetaTxGateway>(ContractName.MetaTxGateway)
                    await this.factory
                        .create<ClearingHouse>(ContractName.ClearingHouse)
                        .deployUpgradableContract(
                            this.deployConfig.initMarginRequirement,
                            this.deployConfig.maintenanceMarginRequirement,
                            this.deployConfig.liquidationFeeRatio,
                            insuranceFundContract.address!,
                            metaTxGatewayContract.address!,
                        )
                },
                async (): Promise<void> => {
                    console.log("metaTxGateway.addToWhitelists...")
                    const clearingHouse = this.factory.create<ClearingHouse>(ContractName.ClearingHouse)
                    const metaTxGateway = await this.factory
                        .create<MetaTxGateway>(ContractName.MetaTxGateway)
                        .instance()
                    await (await metaTxGateway.addToWhitelists(clearingHouse.address!)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("insuranceFundContract.setBeneficiary...")
                    const clearingHouse = this.factory.create<ClearingHouse>(ContractName.ClearingHouse)
                    const insuranceFund = await this.factory
                        .create<InsuranceFund>(ContractName.InsuranceFund)
                        .instance()
                    await (await insuranceFund.setBeneficiary(clearingHouse.address!)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("clearingHouse add arb to whitelist...")
                    const clearingHouse = await this.factory
                        .create<ClearingHouse>(ContractName.ClearingHouse)
                        .instance()
                    await (
                        await clearingHouse.setWhitelist(this.settingsDao.getExternalContracts("layer2").arbitrageur!)
                    ).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("deploy ETHUSDC amm...")
                    const ammName = AmmInstanceName.ETHUSDC
                    const l2PriceFeedContract = this.factory.create<L2PriceFeed>(ContractName.L2PriceFeed)
                    const ammContract = this.factory.createAmm(ammName)
                    const quoteTokenAddr = this.externalContract.usdc!
                    await ammContract.deployUpgradableContract(
                        this.deployConfig.legacyAmmConfigMap[ammName].deployArgs,
                        l2PriceFeedContract.address!,
                        quoteTokenAddr,
                    )
                },
                async (): Promise<void> => {
                    console.log("deploy BTCUSDC amm...")
                    const l2PriceFeedContract = this.factory.create<L2PriceFeed>(ContractName.L2PriceFeed)
                    const ammName = AmmInstanceName.BTCUSDC
                    const ammContract = this.factory.createAmm(ammName)
                    const quoteTokenAddr = this.externalContract.usdc!
                    await ammContract.deployUpgradableContract(
                        this.deployConfig.legacyAmmConfigMap[ammName].deployArgs,
                        l2PriceFeedContract.address!,
                        quoteTokenAddr,
                    )
                },
                async (): Promise<void> => {
                    console.log("deploy clearingHouseViewer...")
                    const clearingHouseContract = this.factory.create<ClearingHouse>(ContractName.ClearingHouse)
                    const clearingHouseViewerContract = this.factory.create<ClearingHouseViewer>(
                        ContractName.ClearingHouseViewer,
                    )
                    await clearingHouseViewerContract.deployImmutableContract(clearingHouseContract.address!)
                },
                async (): Promise<void> => {
                    console.log("deploy ammReader...")
                    const ammReaderContract = this.factory.create<AmmReader>(ContractName.AmmReader)
                    await ammReaderContract.deployImmutableContract()
                },
                async (): Promise<void> => {
                    console.log("metaTxGateway add clientBridge to whitelist...")
                    const metaTxGatewayContract = this.factory.create<MetaTxGateway>(ContractName.MetaTxGateway)
                    const metaTxGateway = await metaTxGatewayContract.instance()
                    const clientBridgeContract = this.factory.create<ClientBridge>(ContractName.ClientBridge)
                    await (await metaTxGateway.addToWhitelists(clientBridgeContract.address!)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("add ETH aggregators to L2PriceFeed")
                    const l2PriceFeed = await this.factory.create<L2PriceFeed>(ContractName.L2PriceFeed).instance()
                    await (
                        await l2PriceFeed.addAggregator(ethers.utils.formatBytes32String(PriceFeedKey.ETH.toString()))
                    ).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("add BTC aggregators to L2PriceFeed")
                    const l2PriceFeed = await this.factory.create<L2PriceFeed>(ContractName.L2PriceFeed).instance()
                    await (
                        await l2PriceFeed.addAggregator(ethers.utils.formatBytes32String(PriceFeedKey.BTC.toString()))
                    ).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("set ETH amm Cap...")
                    const amm = await this.factory.createAmm(AmmInstanceName.ETHUSDC).instance()
                    const { maxHoldingBaseAsset, openInterestNotionalCap } = this.deployConfig.legacyAmmConfigMap[
                        AmmInstanceName.ETHUSDC
                    ].properties
                    if (maxHoldingBaseAsset.gt(0)) {
                        await (
                            await amm.setCap(
                                { d: maxHoldingBaseAsset.toString() },
                                { d: openInterestNotionalCap.toString() },
                            )
                        ).wait(this.confirmations)
                    }
                },
                async (): Promise<void> => {
                    console.log("ETH amm.setCounterParty...")
                    const clearingHouseContract = this.factory.create<ClearingHouse>(ContractName.ClearingHouse)
                    const amm = await this.factory.createAmm(AmmInstanceName.ETHUSDC).instance()
                    await (await amm.setCounterParty(clearingHouseContract.address!)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("insuranceFund.add ETH amm...")
                    const insuranceFundContract = this.factory.create<InsuranceFund>(ContractName.InsuranceFund)
                    const ammContract = this.factory.createAmm(AmmInstanceName.ETHUSDC)
                    const insuranceFund = await insuranceFundContract.instance()
                    await (await insuranceFund.addAmm(ammContract.address!)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("set BTC amm Cap...")
                    const amm = await this.factory.createAmm(AmmInstanceName.BTCUSDC).instance()
                    const { maxHoldingBaseAsset, openInterestNotionalCap } = this.deployConfig.legacyAmmConfigMap[
                        AmmInstanceName.BTCUSDC
                    ].properties
                    if (maxHoldingBaseAsset.gt(0)) {
                        await (
                            await amm.setCap(
                                { d: maxHoldingBaseAsset.toString() },
                                { d: openInterestNotionalCap.toString() },
                            )
                        ).wait(this.confirmations)
                    }
                },
                async (): Promise<void> => {
                    console.log("BTC amm.setCounterParty...")
                    const clearingHouseContract = this.factory.create<ClearingHouse>(ContractName.ClearingHouse)
                    const amm = await this.factory.createAmm(AmmInstanceName.BTCUSDC).instance()
                    await (await amm.setCounterParty(clearingHouseContract.address!)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("insuranceFund.add BTC amm...")
                    const insuranceFundContract = this.factory.create<InsuranceFund>(ContractName.InsuranceFund)
                    const ammContract = this.factory.createAmm(AmmInstanceName.BTCUSDC)
                    const insuranceFund = await insuranceFundContract.instance()
                    await (await insuranceFund.addAmm(ammContract.address!)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("l2priceFeed setRootBridge...")
                    const l2PriceFeed = await this.factory.create<L2PriceFeed>(ContractName.L2PriceFeed).instance()
                    await (
                        await l2PriceFeed!.setRootBridge(
                            this.systemMetadataDao.getContractMetadata("layer1", ContractName.RootBridge).address,
                        )
                    ).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("opening Amm ETHUSDC...")
                    const ethUsdc = await this.factory.createAmm(AmmInstanceName.ETHUSDC).instance()
                    await (await ethUsdc.setOpen(true)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("opening Amm BTCUSDC...")
                    const btcUsdc = await this.factory.createAmm(AmmInstanceName.BTCUSDC).instance()
                    await (await btcUsdc.setOpen(true)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.foundationGovernance!
                    console.log(
                        `transferring metaTxGateway's owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const metaTxGateway = await this.factory
                        .create<MetaTxGateway>(ContractName.MetaTxGateway)
                        .instance()
                    await (await metaTxGateway.setOwner(gov)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.foundationGovernance!
                    console.log(
                        `transferring clientBridge's owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const clientBridge = await this.factory.create<ClientBridge>(ContractName.ClientBridge).instance()
                    await (await clientBridge.setOwner(gov)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.foundationGovernance!
                    console.log(
                        `transferring insuranceFund's owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const insuranceFund = await this.factory
                        .create<InsuranceFund>(ContractName.InsuranceFund)
                        .instance()
                    await (await insuranceFund.setOwner(gov)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.foundationGovernance!
                    console.log(
                        `transferring l2PriceFeed's owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const l2PriceFeed = await this.factory.create<L2PriceFeed>(ContractName.L2PriceFeed).instance()
                    await (await l2PriceFeed.setOwner(gov)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.foundationGovernance!
                    console.log(
                        `transferring clearingHouse's owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const clearingHouse = await this.factory
                        .create<ClearingHouse>(ContractName.ClearingHouse)
                        .instance()
                    await (await clearingHouse.setOwner(gov)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.foundationGovernance!
                    console.log(
                        `transferring ETHUSDC owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const ETHUSDC = await this.factory.createAmm(AmmInstanceName.ETHUSDC).instance()
                    await (await ETHUSDC.setOwner(gov)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.foundationGovernance!
                    console.log(
                        `transferring BTCUSDC owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const BTCUSDC = await this.factory.createAmm(AmmInstanceName.BTCUSDC).instance()
                    await (await BTCUSDC.setOwner(gov)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    if (this.inSameLayer) {
                        return
                    }
                    const governance = this.externalContract.foundationGovernance!
                    console.log(`${this.layerType} batch ends, transfer proxy admin to ${governance}`)
                    await OzContractDeployer.transferProxyAdminOwnership(governance)
                },
            ],
            // batch 1 (optional)
            // deploy a new implementation of ClearingHouse, in order to make xdai blockscout verification works,
            // we'll deploy a flatten one in an isolated build env. then PROXY_ADMIN should upgrade proxy to the new implementation
            [
                async (): Promise<void> => {
                    const filename = `${ContractName.ClearingHouse}.sol`

                    // after flatten sol file we must re-compile again
                    await flatten(SRC_DIR, bre.config.paths.sources, filename)
                    await bre.run(TASK_COMPILE)

                    // deploy clearing house implementation
                    const contract = this.factory.create<ClearingHouse>(ContractName.ClearingHouse)
                    await contract.prepareUpgradeContract()
                },
            ],
            // batch 2 (optional)
            // deploy a new implementation of Amm, in order to make xdai blockscout verification works,
            // we'll deploy a flatten one in an isolated build env. then PROXY_ADMIN should upgrade proxy to the new implementation
            [
                async (): Promise<void> => {
                    const filename = `${ContractName.Amm}.sol`

                    // after flatten sol file we must re-compile again
                    await flatten(SRC_DIR, bre.config.paths.sources, filename)
                    await bre.run(TASK_COMPILE)

                    // deploy amm implementation
                    const ETHUSDC = this.factory.createAmm(AmmInstanceName.ETHUSDC)
                    await ETHUSDC.prepareUpgradeContract()

                    const BTCUSDC = this.factory.createAmm(AmmInstanceName.BTCUSDC)
                    await BTCUSDC.prepareUpgradeContract()
                },
            ],
            // batch 3
            // deploy the third amm instance for new market
            // set cap, counterParty, set open...etc
            // transfer owner
            // transfer proxyAdmin
            [
                async (): Promise<void> => {
                    console.log("deploy YFIUSDC amm...")
                    const l2PriceFeedContract = this.factory.create<L2PriceFeed>(ContractName.L2PriceFeed)
                    const ammName = AmmInstanceName.YFIUSDC
                    const ammContract = this.factory.createAmm(ammName)
                    const quoteTokenAddr = this.externalContract.usdc!
                    await ammContract.deployUpgradableContract(
                        this.deployConfig.legacyAmmConfigMap[ammName].deployArgs,
                        l2PriceFeedContract.address!,
                        quoteTokenAddr,
                    )
                },
                async (): Promise<void> => {
                    console.log("set YFI amm Cap...")
                    const amm = await this.factory.createAmm(AmmInstanceName.YFIUSDC).instance()
                    const { maxHoldingBaseAsset, openInterestNotionalCap } = this.deployConfig.legacyAmmConfigMap[
                        AmmInstanceName.YFIUSDC
                    ].properties
                    if (maxHoldingBaseAsset.gt(0)) {
                        await (
                            await amm.setCap(
                                { d: maxHoldingBaseAsset.toString() },
                                { d: openInterestNotionalCap.toString() },
                            )
                        ).wait(this.confirmations)
                    }
                },
                async (): Promise<void> => {
                    console.log("YFI amm.setCounterParty...")
                    const clearingHouseContract = this.factory.create<ClearingHouse>(ContractName.ClearingHouse)
                    const amm = await this.factory.createAmm(AmmInstanceName.YFIUSDC).instance()
                    await (await amm.setCounterParty(clearingHouseContract.address!)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("opening Amm YFIUSDC...")
                    const YFIUSDC = await this.factory.createAmm(AmmInstanceName.YFIUSDC).instance()
                    await (await YFIUSDC.setOpen(true)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.foundationGovernance!
                    console.log(
                        `transferring YFIUSDC owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const YFIUSDC = await this.factory.createAmm(AmmInstanceName.YFIUSDC).instance()
                    await (await YFIUSDC.setOwner(gov)).wait(this.confirmations)
                },
            ],
            // batch 4
            // prepareUpgrade the flatten YFI AMM
            [
                async (): Promise<void> => {
                    const filename = `${ContractName.Amm}.sol`

                    // after flatten sol file we must re-compile again
                    await flatten(SRC_DIR, bre.config.paths.sources, filename)
                    await bre.run(TASK_COMPILE)

                    // deploy amm implementation
                    const YFIUSDC = this.factory.createAmm(AmmInstanceName.YFIUSDC)
                    await YFIUSDC.prepareUpgradeContract()
                },
            ],
            // batch 5
            // deploy the fourth amm instance for new market
            // set cap, counterParty, set open...etc
            // transfer owner
            // transfer proxyAdmin
            [
                async (): Promise<void> => {
                    console.log("deploy DOTUSDC amm...")
                    const l2PriceFeedContract = this.factory.create<L2PriceFeed>(ContractName.L2PriceFeed)
                    const ammName = AmmInstanceName.DOTUSDC
                    const ammContract = this.factory.createAmm(ammName)
                    const quoteTokenAddr = this.externalContract.usdc!
                    await ammContract.deployUpgradableContract(
                        this.deployConfig.legacyAmmConfigMap[ammName].deployArgs,
                        l2PriceFeedContract.address!,
                        quoteTokenAddr,
                    )
                },
                async (): Promise<void> => {
                    console.log("set DOT amm Cap...")
                    const amm = await this.factory.createAmm(AmmInstanceName.DOTUSDC).instance()
                    const { maxHoldingBaseAsset, openInterestNotionalCap } = this.deployConfig.legacyAmmConfigMap[
                        AmmInstanceName.DOTUSDC
                    ].properties
                    if (maxHoldingBaseAsset.gt(0)) {
                        await (
                            await amm.setCap(
                                { d: maxHoldingBaseAsset.toString() },
                                { d: openInterestNotionalCap.toString() },
                            )
                        ).wait(this.confirmations)
                    }
                },
                async (): Promise<void> => {
                    console.log("DOT amm.setCounterParty...")
                    const clearingHouseContract = this.factory.create<ClearingHouse>(ContractName.ClearingHouse)
                    const amm = await this.factory.createAmm(AmmInstanceName.DOTUSDC).instance()
                    await (await amm.setCounterParty(clearingHouseContract.address!)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("opening Amm DOTUSDC...")
                    const DOTUSDC = await this.factory.createAmm(AmmInstanceName.DOTUSDC).instance()
                    await (await DOTUSDC.setOpen(true)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.foundationGovernance!
                    console.log(
                        `transferring DOTUSDC owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const DOTUSDC = await this.factory.createAmm(AmmInstanceName.DOTUSDC).instance()
                    await (await DOTUSDC.setOwner(gov)).wait(this.confirmations)
                },
            ],
            // batch 6
            // deploy the flattened amm for DOT (production), or LINK (staging)
            // cant prepare upgrade for other amm due to openzeppelin upgrade sdk issue
            // https://github.com/OpenZeppelin/openzeppelin-upgrades/issues/175
            [
                async (): Promise<void> => {
                    const filename = `${ContractName.Amm}.sol`

                    // after flatten sol file we must re-compile again
                    await flatten(SRC_DIR, bre.config.paths.sources, filename)
                    await bre.run(TASK_COMPILE)

                    // deploy amm implementation
                    const DOTUSDC = this.factory.createAmm(AmmInstanceName.DOTUSDC)
                    const dotUsdcImplAddr = await DOTUSDC.prepareUpgradeContract()

                    // in normal case we don't need to do anything to the implementation contract
                    const ammImplInstance = (await ethers.getContractAt(ContractName.Amm, dotUsdcImplAddr)) as Amm
                    const wei = BigNumber.from(1)
                    const emptyAddr = "0x0000000000000000000000000000000000000001"
                    await ammImplInstance.initialize(
                        wei,
                        wei,
                        wei,
                        wei,
                        emptyAddr,
                        ethers.utils.formatBytes32String(""),
                        emptyAddr,
                        wei,
                        wei,
                        wei,
                    )
                },
            ],
            // batch 7
            // deploy the flattened clearingHouse and init it just in case
            [
                async (): Promise<void> => {
                    const filename = `${ContractName.ClearingHouse}.sol`

                    // after flatten sol file we must re-compile again
                    await flatten(SRC_DIR, bre.config.paths.sources, filename)
                    await bre.run(TASK_COMPILE)

                    // deploy clearing house implementation
                    const clearingHouseContract = await this.factory.create<ClearingHouse>(ContractName.ClearingHouse)
                    const implContractAddr = await clearingHouseContract.prepareUpgradeContract()

                    // in normal case we don't need to do anything to the implementation contract
                    const insuranceFundContract = this.factory.create<InsuranceFund>(ContractName.InsuranceFund)
                    const metaTxGatewayContract = this.factory.create<MetaTxGateway>(ContractName.MetaTxGateway)
                    const clearingHouseImplInstance = (await ethers.getContractAt(
                        ContractName.ClearingHouse,
                        implContractAddr,
                    )) as ClearingHouse
                    await clearingHouseImplInstance.initialize(
                        this.deployConfig.initMarginRequirement,
                        this.deployConfig.maintenanceMarginRequirement,
                        this.deployConfig.liquidationFeeRatio,
                        insuranceFundContract.address!,
                        metaTxGatewayContract.address!,
                    )
                },
            ],
            // batch 8
            // deploy the new amm instance for new market
            // set cap, counterParty, set open...etc
            // transfer owner
            // transfer proxyAdmin
            [
                async (): Promise<void> => {
                    console.log("deploy SNXUSDC amm...")
                    const l2PriceFeedContract = this.factory.create<L2PriceFeed>(ContractName.L2PriceFeed)
                    const ammContract = this.factory.createAmm(AmmInstanceName.SNXUSDC)
                    const quoteTokenAddr = this.externalContract.usdc!
                    await ammContract.deployUpgradableContract(
                        this.deployConfig.legacyAmmConfigMap[AmmInstanceName.SDEFIUSDC].deployArgs,
                        l2PriceFeedContract.address!,
                        quoteTokenAddr,
                    )
                },
                async (): Promise<void> => {
                    console.log("set SNX amm Cap...")
                    const amm = await this.factory.createAmm(AmmInstanceName.SNXUSDC).instance()
                    const { maxHoldingBaseAsset, openInterestNotionalCap } = this.deployConfig.legacyAmmConfigMap[
                        AmmInstanceName.SNXUSDC
                    ].properties
                    if (maxHoldingBaseAsset.gt(0)) {
                        await (
                            await amm.setCap(
                                { d: maxHoldingBaseAsset.toString() },
                                { d: openInterestNotionalCap.toString() },
                            )
                        ).wait(this.confirmations)
                    }
                },
                async (): Promise<void> => {
                    console.log("SNX amm.setCounterParty...")
                    const clearingHouseContract = this.factory.create<ClearingHouse>(ContractName.ClearingHouse)
                    const amm = await this.factory.createAmm(AmmInstanceName.SNXUSDC).instance()
                    await (await amm.setCounterParty(clearingHouseContract.address!)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    console.log("opening Amm SNXUSDC...")
                    const SNXUSDC = await this.factory.createAmm(AmmInstanceName.SNXUSDC).instance()
                    await (await SNXUSDC.setOpen(true)).wait(this.confirmations)
                },
                async (): Promise<void> => {
                    const gov = this.externalContract.foundationGovernance!
                    console.log(
                        `transferring SNXUSDC owner to governance=${gov}...please remember to claim the ownership`,
                    )
                    const SNXUSDC = await this.factory.createAmm(AmmInstanceName.SNXUSDC).instance()
                    await (await SNXUSDC.setOwner(gov)).wait(this.confirmations)
                },
            ],
        ]

        // layer 2, batch 9
        if (this.deployConfig.stage === "production") {
            const linkAmmConfig = makeAmmConfig(
                AmmInstanceName.LINKUSDC,
                "LINK",
                BigNumber.from(300_000).mul(DEFAULT_DIGITS),
                DEFAULT_DIGITS.mul(5000),
                BigNumber.from(DEFAULT_DIGITS).mul(2_000_000),
            )
            const batch = makeAmmDeployBatch(
                linkAmmConfig,
                this.factory,
                this.externalContract,
                this.deployConfig.confirmations,
            )
            this.taskBatchesMap.layer2.push(batch)
        } else {
            const trxAmmConfig = makeAmmConfig(
                AmmInstanceName.TRXUSDC,
                "TRX",
                BigNumber.from(300_000).mul(DEFAULT_DIGITS),
                DEFAULT_DIGITS.mul(5000),
                BigNumber.from(DEFAULT_DIGITS).mul(2_000_000),
            )
            const batch = makeAmmDeployBatch(
                trxAmmConfig,
                this.factory,
                this.externalContract,
                this.deployConfig.confirmations,
            )
            this.taskBatchesMap.layer2.push(batch)
        }

        // layer 2, batch 10
        if (this.deployConfig.stage === "production") {
            const aaveAmmConfig = makeAmmConfig(
                AmmInstanceName.AAVEUSDC,
                "AAVE",
                BigNumber.from(20_000).mul(DEFAULT_DIGITS),
                DEFAULT_DIGITS.mul(250),
                BigNumber.from(DEFAULT_DIGITS).mul(2_000_000),
            )
            const batch = makeAmmDeployBatch(
                aaveAmmConfig,
                this.factory,
                this.externalContract,
                this.deployConfig.confirmations,
                true,
            )
            this.taskBatchesMap.layer2.push(batch)
        } else {
            const sCexAmmConfig = makeAmmConfig(
                AmmInstanceName.SCEXUSDC,
                "sCEX",
                BigNumber.from(12_000).mul(DEFAULT_DIGITS),
                DEFAULT_DIGITS.mul(250),
                BigNumber.from(DEFAULT_DIGITS).mul(2_000_000),
            )
            const batch = makeAmmDeployBatch(
                sCexAmmConfig,
                this.factory,
                this.externalContract,
                this.deployConfig.confirmations,
                true,
            )
            this.taskBatchesMap.layer2.push(batch)
        }

        // layer 2, batch 11
        const upgradeAmmBatch = [
            async () => {
                const filename = `${ContractName.Amm}.sol`

                // after flatten sol file we must re-compile again
                await flatten(SRC_DIR, bre.config.paths.sources, filename)
                await bre.run(TASK_COMPILE)

                // deploy clearing house implementation
                // proxy does not use here, we just use createAmm to create an implementation
                const contract = this.factory.createAmm(AmmInstanceName.BTCUSDC)
                const impAddress = await contract.prepareUpgradeContract()
                const amm = (await ethers.getContractAt(ContractName.Amm, impAddress)) as Amm
                const wei = BigNumber.from(1)
                const emptyAddr = "0x0000000000000000000000000000000000000001"
                await amm.initialize(
                    wei,
                    wei,
                    wei,
                    wei,
                    emptyAddr,
                    ethers.utils.formatBytes32String(""),
                    emptyAddr,
                    wei,
                    wei,
                    wei,
                )
            },
        ]
        this.taskBatchesMap.layer2.push(upgradeAmmBatch)
    }

    get confirmations(): number {
        return this.deployConfig.confirmations
    }

    // local are basically in 1 layer, can't transfer twice in the same network. will transfer in the very last batch
    get inSameLayer(): boolean {
        return this.settingsDao.getChainId("layer1") === this.settingsDao.getChainId("layer2")
    }

    async publishContracts(batch: number): Promise<void> {
        const taskBatches = this.taskBatchesMap[this.layerType]
        const completeTasksLength = taskBatches.flat().length
        const tasks = taskBatches[batch]
        if (!taskBatches.length || !tasks) {
            return
        }

        const batchStartVer = taskBatches.slice(0, batch).flat().length
        const batchEndVer = batchStartVer + tasks.length
        console.log(`layer:${this.layerType}, batchStartVer: ${batchStartVer}, batchEndVer: ${batchEndVer}`)

        const ver = this.settingsDao.getVersion(this.layerType)
        if (ver < batchStartVer) {
            throw new Error(
                `starting version (${ver}) is less than the batch's start version (${batchStartVer}), are you sure the previous batches are completed?`,
            )
        }
        console.log(`publishContracts:${ver}->${completeTasksLength}`)

        // clear metadata if it's the first version
        if (ver === 0) {
            console.log("clearing metadata...")
            this.systemMetadataDao.clearMetadata(this.layerType)
        }

        for (const task of tasks.slice(ver - batchStartVer, batchEndVer - batchStartVer)) {
            await task()
            this.settingsDao.increaseVersion(this.layerType)
        }

        console.log(`${this.layerType} contract deployment batch=${batch} finished.`)
    }
}
