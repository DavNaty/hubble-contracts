import { Usage } from "../scripts/helpers/interfaces";
import { deployAll } from "../ts/deploy";
import { TESTING_PARAMS } from "../ts/constants";
import { ethers } from "@nomiclabs/buidler";
import { StateTree } from "./utils/state_tree";
import { AccountRegistry } from "./utils/account_tree";
import { Account } from "./utils/state_account";
import { TxTransfer } from "./utils/tx";
import * as mcl from "./utils/mcl";
import { Tree, Hasher } from "./utils/tree";
import { allContracts } from "../ts/all-contracts-interfaces";
import { assert } from "chai";

describe("Rollup", async function() {
    let Alice: Account;
    let Bob: Account;

    let contracts: allContracts;
    let stateTree: StateTree;
    let registry: AccountRegistry;
    before(async function() {
        await mcl.init();
    });

    beforeEach(async function() {
        const accounts = await ethers.getSigners();
        contracts = await deployAll(accounts[0], TESTING_PARAMS);
        stateTree = new StateTree(TESTING_PARAMS.MAX_DEPTH);
        const registryContract = contracts.blsAccountRegistry;
        registry = await AccountRegistry.new(registryContract);
        const appID =
            "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        const tokenID = 1;

        Alice = Account.new(appID, -1, tokenID, 10, 0);
        Alice.setStateID(2);
        Alice.newKeyPair();
        Alice.accountID = await registry.register(Alice.encodePubkey());

        Bob = Account.new(appID, -1, tokenID, 10, 0);
        Bob.setStateID(3);
        Bob.newKeyPair();
        Bob.accountID = await registry.register(Bob.encodePubkey());

        stateTree.createAccount(Alice);
        stateTree.createAccount(Bob);
    });

    it("submit a batch and dispute", async function() {
        const tx = new TxTransfer(
            Alice.stateID,
            Bob.stateID,
            5,
            1,
            Alice.nonce + 1
        );

        const signature = Alice.sign(tx);

        const rollup = contracts.rollup;
        const rollupUtils = contracts.rollupUtils;
        const stateRoot = stateTree.root;
        const proof = stateTree.applyTxTransfer(tx);
        const txs = ethers.utils.arrayify(tx.encode(true));
        await rollup.submitBatch(
            [txs],
            [stateRoot],
            Usage.Transfer,
            [mcl.g1ToHex(signature)],
            { value: ethers.utils.parseEther(TESTING_PARAMS.STAKE_AMOUNT) }
        );

        const batchId = Number(await rollup.numOfBatchesSubmitted()) - 1;
        const root = await registry.root();
        const rootOnchain = await registry.registry.root();
        assert.equal(root, rootOnchain, "mismatch pubkey tree root");
        const batch = await rollup.getBatch(batchId);

        const commitment = {
            stateRoot,
            accountRoot: root,
            txHashCommitment: ethers.utils.solidityKeccak256(["bytes"], [txs]),
            signature: mcl.g1ToHex(signature),
            batchType: Usage.Transfer
        };
        const depth = 1; // Math.log2(commitmentLength + 1)
        const tree = Tree.new(
            depth,
            Hasher.new(
                "bytes",
                ethers.utils.keccak256(
                    "0x0000000000000000000000000000000000000000000000000000000000000000"
                )
            )
        );
        const leaf = await rollupUtils.CommitmentToHash(
            commitment.stateRoot,
            commitment.accountRoot,
            commitment.txHashCommitment,
            commitment.signature,
            commitment.batchType
        );
        const abiCoder = ethers.utils.defaultAbiCoder;
        const hash = ethers.utils.keccak256(
            abiCoder.encode(
                ["bytes32", "bytes32", "bytes32", "uint256[2]", "uint8"],
                [
                    commitment.stateRoot,
                    commitment.accountRoot,
                    commitment.txHashCommitment,
                    commitment.signature,
                    commitment.batchType
                ]
            )
        );
        assert.equal(hash, leaf, "mismatch commitment hash");
        tree.updateSingle(0, hash);
        assert.equal(
            batch.commitmentRoot,
            tree.root,
            "mismatch commitment tree root"
        );

        const commitmentMP = {
            commitment,
            pathToCommitment: 0,
            witness: tree.witness(0).nodes
        };

        await rollup.disputeBatch(batchId, commitmentMP, txs, {
            accountProofs: [
                {
                    from: {
                        accountIP: {
                            pathToAccount: Alice.stateID,
                            account: proof.senderAccount
                        },
                        siblings: proof.senderWitness.map(ethers.utils.arrayify)
                    },
                    to: {
                        accountIP: {
                            pathToAccount: Bob.stateID,
                            account: proof.receiverAccount
                        },
                        siblings: proof.receiverWitness.map(
                            ethers.utils.arrayify
                        )
                    }
                }
            ]
        });
    });
});
