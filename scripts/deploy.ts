/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ExecOptions } from "child_process"
import { SettingsDao } from "../publish/SettingsDao"
import { Stage, TASK_DEPLOY_LAYER } from "./common"
import { asyncExec } from "./helper"

export async function deploy(stage: Stage, options?: ExecOptions): Promise<void> {
    const settings = new SettingsDao(stage)
    const layer1Network = settings.getNetwork("layer1")
    const layer2Network = settings.getNetwork("layer2")

    // test stage deploys only to layer2 and always restarts from initial version
    if ("test" === stage) {
        settings.setVersion("layer1", 0)
        settings.setVersion("layer2", 0)
    }

    // #1
    // we have to break deployment up into multiple batches because:
    // (1) layer1 and layer2 contracts have circular dependencies
    // (2) buidler only works with one network at a time

    // V1
    await asyncExec(`buidler --network ${layer1Network} ${TASK_DEPLOY_LAYER} ${stage} layer1 0`, options)
    await asyncExec(`buidler --network ${layer2Network} ${TASK_DEPLOY_LAYER} ${stage} layer2 0`, options)
    await asyncExec(`buidler --network ${layer1Network} ${TASK_DEPLOY_LAYER} ${stage} layer1 1`, options)
    await asyncExec(
        `buidler --network ${layer2Network} --config buidler.flatten.clearinghouse.config.ts ${TASK_DEPLOY_LAYER} ${stage} layer2 1`,
        options,
    )
    await asyncExec(
        `buidler --network ${layer2Network} --config buidler.flatten.amm.config.ts ${TASK_DEPLOY_LAYER} ${stage} layer2 2`,
        options,
    )

    // #2 deploy the 3rd market (production=YFI, staging=SNX)
    await asyncExec(`buidler --network ${layer2Network} ${TASK_DEPLOY_LAYER} ${stage} layer2 3`, options)
    await asyncExec(
        `buidler --network ${layer2Network} --config buidler.flatten.amm.config.ts ${TASK_DEPLOY_LAYER} ${stage} layer2 4`,
        options,
    )

    // #3 deploy the 3rd market (production=DOT, staging=LINK)
    await asyncExec(`buidler --network ${layer2Network} ${TASK_DEPLOY_LAYER} ${stage} layer2 5`, options)

    // #4 upgrade Amm contract (production=DOT, staging=LINK) from V1
    await asyncExec(
        `buidler --network ${layer2Network} --config buidler.flatten.amm.config.ts ${TASK_DEPLOY_LAYER} ${stage} layer2 6`,
        options,
    )

    // #5 upgrade ClearingHouse contract from V1
    await asyncExec(
        `buidler --network ${layer2Network} --config buidler.flatten.clearinghouse.config.ts ${TASK_DEPLOY_LAYER} ${stage} layer2 7`,
        options,
    )

    // #6 deploy the market (production=SNX, staging=sDEFI)
    await asyncExec(`buidler --network ${layer2Network} ${TASK_DEPLOY_LAYER} ${stage} layer2 8`, options)

    // #7 deploy PERP RewardVesting in layer 1
    await asyncExec(`buidler --network ${layer1Network} ${TASK_DEPLOY_LAYER} ${stage} layer1 2`, options)

    // deploy the market (production=LINK, staging=TRX)
    await asyncExec(
        `buidler --network ${layer2Network} --config buidler.flatten.amm.config.ts ${TASK_DEPLOY_LAYER} ${stage} layer2 9`,
        options,
    )

    // deploy the market (production=AAVE, staging=sCEX)
    await asyncExec(
        `buidler --network ${layer2Network} --config buidler.flatten.amm.config.ts ${TASK_DEPLOY_LAYER} ${stage} layer2 10`,
        options,
    )

    // prepare upgrading AMM, deploy new implementation without actually update it in proxy
    await asyncExec(
        `buidler --network ${layer2Network} --config buidler.flatten.amm.config.ts ${TASK_DEPLOY_LAYER} ${stage} layer2 11`,
        options,
    )

    await asyncExec(`buidler --network ${layer2Network} ${TASK_DEPLOY_LAYER} ${stage} layer2 12`, options)

    // deploy the market (production=SUSHI, staging=SUSHI)
    await asyncExec(
        `buidler --network ${layer2Network} --config buidler.flatten.amm.config.ts ${TASK_DEPLOY_LAYER} ${stage} layer2 13`,
        options,
    )
}

/* eslint-disable no-console */
async function main(): Promise<void> {
    const stage = process.argv[2] as Stage
    await deploy(stage)
}

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error)
            process.exit(1)
        })
}
