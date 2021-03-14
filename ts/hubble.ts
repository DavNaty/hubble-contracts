import { allContracts } from "./allContractsInterfaces";
import { DeploymentParameters } from "./interfaces";
import { ExampleTokenFactory } from "../types/ethers-contracts";
import { ethers, Signer } from "ethers";
import { solG2 } from "./mcl";
import { toWei } from "./utils";
import { Genesis } from "./genesis";

export class Hubble {
    private constructor(
        public parameters: DeploymentParameters,
        public contracts: allContracts,
        public signer: Signer
    ) {}
    static fromGenesis(genesis: Genesis, signer: Signer) {
        const contracts = genesis.getContracts(signer);
        return new Hubble(genesis.parameters, contracts, signer);
    }

    static fromDefault(
        providerUrl = "http://localhost:8545",
        genesisPath = "./genesis.json"
    ) {
        const provider = new ethers.providers.JsonRpcProvider(providerUrl);
        const signer = provider.getSigner();
        const genesis = Genesis.fromConfig(genesisPath);
        return Hubble.fromGenesis(genesis, signer);
    }

    async registerPublicKeys(pubkeys: string[]) {
        const registry = this.contracts.blsAccountRegistry;
        const accountIDs: number[] = [];
        console.log(`Registering ${pubkeys.length} public keys`);
        for (const pubkeyRaw of pubkeys) {
            const parsedPubkey: solG2 = [
                "0x" + pubkeyRaw.slice(64, 128),
                "0x" + pubkeyRaw.slice(0, 64),
                "0x" + pubkeyRaw.slice(192, 256),
                "0x" + pubkeyRaw.slice(128, 192)
            ];
            console.log("Registering", parsedPubkey);
            const accID = await registry.callStatic.register(parsedPubkey);
            const tx = await registry.register(parsedPubkey);
            await tx.wait();
            accountIDs.push(accID.toNumber());
            console.log(
                "Done registering pubkey",
                pubkeyRaw.slice(0, 5),
                accID.toNumber()
            );
        }
        return accountIDs;
    }
    async depositFor(pubkeyIDs: number[], tokenID: number, amount: number) {
        console.log(
            `Depositing tokenID ${tokenID} for pubkeyID ${pubkeyIDs} each with amount ${amount}`
        );
        const { tokenRegistry, depositManager } = this.contracts;
        const tokenAddress = await tokenRegistry.safeGetAddress(tokenID);
        const erc20 = ExampleTokenFactory.connect(tokenAddress, this.signer);
        // approve depositmanager for amount
        const totalAmount = pubkeyIDs.length * amount;
        console.log("Approving total amount", totalAmount);
        const approveTx = await erc20.approve(
            depositManager.address,
            toWei(totalAmount.toString())
        );
        await approveTx.wait();

        console.log("token approved", approveTx.hash.toString());

        for (const pubkeyID of pubkeyIDs) {
            console.log(`Depositing ${amount} for pubkeyID ${pubkeyID}`);
            const tx = await depositManager.depositFor(
                pubkeyID,
                amount,
                tokenID
            );
            await tx.wait();
        }
    }
}
