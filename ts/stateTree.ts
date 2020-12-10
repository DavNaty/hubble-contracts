import { Hasher, Tree } from "./tree";
import { State, ZERO_STATE } from "./state";
import { TxTransfer, TxMassMigration, TxCreate2Transfer } from "./tx";
import { BigNumber, constants } from "ethers";
import { ZERO_BYTES32 } from "./constants";
import { sum } from "./utils";
import {
    InsufficientFund,
    ReceiverNotExist,
    SenderNotExist,
    StateAlreadyExist,
    WrongTokenID
} from "./exceptions";

interface SolStateMerkleProof {
    state: State;
    witness: string[];
}

const STATE_WITNESS_LENGHT = 32;

const PLACEHOLDER_PROOF_WITNESS = Array(STATE_WITNESS_LENGHT).fill(
    constants.HashZero
);

const PLACEHOLDER_SOL_STATE_PROOF: SolStateMerkleProof = {
    state: ZERO_STATE,
    witness: PLACEHOLDER_PROOF_WITNESS
};

function applySender(sender: State, decrement: BigNumber): State {
    const state = sender.clone();
    state.balance = sender.balance.sub(decrement);
    state.nonce = sender.nonce + 1;
    return state;
}
function applyReceiver(receiver: State, increment: BigNumber): State {
    const state = receiver.clone();
    state.balance = receiver.balance.add(increment);
    return state;
}

function processNoRaise(
    generator: Generator<SolStateMerkleProof>,
    expectedNumProofs: number
): { proofs: SolStateMerkleProof[]; safe: boolean } {
    let proofs: SolStateMerkleProof[] = [];
    let safe = true;
    for (let i = 0; i < expectedNumProofs; i++) {
        if (!safe) {
            proofs.push(PLACEHOLDER_SOL_STATE_PROOF);
            continue;
        }
        try {
            proofs.push(generator.next().value);
        } catch (error) {
            safe = false;
        }
    }
    return { proofs, safe };
}

export class StateTree {
    public static new(stateDepth: number) {
        return new StateTree(stateDepth);
    }
    private stateTree: Tree;
    private states: { [key: number]: State } = {};
    constructor(stateDepth: number) {
        this.stateTree = Tree.new(
            stateDepth,
            Hasher.new("bytes", ZERO_BYTES32)
        );
    }

    public getState(stateID: number): SolStateMerkleProof {
        const queried = this.states[stateID];
        const state = queried ? queried : ZERO_STATE;
        const witness = this.stateTree.witness(stateID).nodes;
        return { state, witness };
    }

    /** Side effect! */
    private updateState(stateID: number, state: State) {
        this.states[stateID] = state;
        this.stateTree.updateSingle(stateID, state.toStateLeaf());
    }

    public getVacancyProof(mergeOffsetLower: number, subtreeDepth: number) {
        const witness = this.stateTree.witnessForBatch(
            mergeOffsetLower,
            subtreeDepth
        );
        const pathAtDepth = mergeOffsetLower >> subtreeDepth;

        return {
            witness: witness.nodes,
            depth: subtreeDepth,
            pathAtDepth
        };
    }

    public depth() {
        return this.stateTree.depth;
    }

    public createState(state: State) {
        const stateID = state.stateID;
        if (this.states[stateID])
            throw new StateAlreadyExist(`stateID: ${stateID}`);
        this.updateState(stateID, state);
    }
    public createStateBulk(states: State[]) {
        for (const state of states) {
            this.createState(state);
        }
    }

    public get root() {
        return this.stateTree.root;
    }
    private *_processTransferCommit(
        txs: TxTransfer[],
        feeReceiverID: number
    ): Generator<SolStateMerkleProof> {
        const tokenID = this.states[txs[0].fromIndex].tokenID;
        for (const tx of txs) {
            const [senderProof, receiverProof] = this.processTransfer(
                tx,
                tokenID
            );
            yield senderProof;
            yield receiverProof;
        }
        const proof = this.processReceiver(
            feeReceiverID,
            sum(txs.map(tx => tx.fee)),
            tokenID
        );
        yield proof;
        return;
    }

    public processTransferCommit(
        txs: TxTransfer[],
        feeReceiverID: number,
        raiseError: boolean = true
    ): {
        proofs: SolStateMerkleProof[];
        safe: boolean;
    } {
        const generator = this._processTransferCommit(txs, feeReceiverID);
        if (raiseError) {
            return { proofs: Array.from(generator), safe: true };
        } else {
            return processNoRaise(generator, txs.length * 2 + 1);
        }
    }
    private *_processCreate2TransferCommit(
        txs: TxCreate2Transfer[],
        feeReceiverID: number
    ): Generator<SolStateMerkleProof> {
        const tokenID = this.states[txs[0].fromIndex].tokenID;
        for (const tx of txs) {
            const [senderProof, receiverProof] = this.processCreate2Transfer(
                tx,
                tokenID
            );
            yield senderProof;
            yield receiverProof;
        }
        const proof = this.processReceiver(
            feeReceiverID,
            sum(txs.map(tx => tx.fee)),
            tokenID
        );
        yield proof;
        return;
    }

    public processCreate2TransferCommit(
        txs: TxCreate2Transfer[],
        feeReceiverID: number,
        raiseError: boolean = true
    ): {
        proofs: SolStateMerkleProof[];
        safe: boolean;
    } {
        const generator = this._processCreate2TransferCommit(
            txs,
            feeReceiverID
        );
        if (raiseError) {
            return { proofs: Array.from(generator), safe: true };
        } else {
            return processNoRaise(generator, txs.length * 2 + 1);
        }
    }
    private *_processMassMigrationCommit(
        txs: TxMassMigration[],
        feeReceiverID: number
    ): Generator<SolStateMerkleProof> {
        const tokenID = this.states[txs[0].fromIndex].tokenID;
        for (const tx of txs) {
            const proof = this.processMassMigration(tx, tokenID);
            yield proof;
        }
        const proof = this.processReceiver(
            feeReceiverID,
            sum(txs.map(tx => tx.fee)),
            tokenID
        );
        yield proof;
        return;
    }

    public processMassMigrationCommit(
        txs: TxMassMigration[],
        feeReceiverID: number,
        raiseError: boolean = true
    ): {
        proofs: SolStateMerkleProof[];
        safe: boolean;
    } {
        const generator = this._processMassMigrationCommit(txs, feeReceiverID);
        if (raiseError) {
            return { proofs: Array.from(generator), safe: true };
        } else {
            return processNoRaise(generator, txs.length + 1);
        }
    }

    public processTransfer(
        tx: TxTransfer,
        tokenID: number
    ): SolStateMerkleProof[] {
        const decrement = tx.amount.add(tx.fee);
        const senderProof = this.processSender(
            tx.fromIndex,
            tokenID,
            decrement
        );
        const receiverProof = this.processReceiver(
            tx.toIndex,
            tx.amount,
            tokenID
        );
        return [senderProof, receiverProof];
    }

    public processMassMigration(
        tx: TxMassMigration,
        tokenID: number
    ): SolStateMerkleProof {
        return this.processSender(tx.fromIndex, tokenID, tx.amount.add(tx.fee));
    }

    public processCreate2Transfer(
        tx: TxCreate2Transfer,
        tokenID: number
    ): SolStateMerkleProof[] {
        const decrement = tx.amount.add(tx.fee);
        const senderProof = this.processSender(
            tx.fromIndex,
            tokenID,
            decrement
        );
        const receiverProof = this.processCreate(
            tx.toIndex,
            tx.toPubkeyID,
            tx.amount,
            tokenID
        );
        return [senderProof, receiverProof];
    }

    private getProofAndUpdate(
        stateID: number,
        postState: State
    ): SolStateMerkleProof {
        const proofBeforeUpdate = this.getState(stateID);
        this.updateState(stateID, postState);
        return proofBeforeUpdate;
    }
    public processSender(
        senderIndex: number,
        tokenID: number,
        decrement: BigNumber
    ): SolStateMerkleProof {
        const state = this.states[senderIndex];
        if (!state) throw new SenderNotExist(`stateID: ${senderIndex}`);
        if (state.balance.lt(decrement))
            throw new InsufficientFund(
                `balance: ${state.balance}, tx amount+fee: ${decrement}`
            );
        if (state.tokenID != tokenID)
            throw new WrongTokenID(
                `Tx tokenID: ${tokenID}, State tokenID: ${state.tokenID}`
            );

        const postState = applySender(state, decrement);
        const proof = this.getProofAndUpdate(senderIndex, postState);
        return proof;
    }
    public processReceiver(
        receiverIndex: number,
        increment: BigNumber,
        tokenID: number
    ): SolStateMerkleProof {
        const state = this.states[receiverIndex];
        if (!state) throw new ReceiverNotExist(`stateID: ${receiverIndex}`);
        if (state.tokenID != tokenID)
            throw new WrongTokenID(
                `Tx tokenID: ${tokenID}, State tokenID: ${state.tokenID}`
            );
        const postState = applyReceiver(state, increment);
        const proof = this.getProofAndUpdate(receiverIndex, postState);
        return proof;
    }

    public processCreate(
        createIndex: number,
        pubkeyID: number,
        balance: BigNumber,
        tokenID: number
    ): SolStateMerkleProof {
        if (this.states[createIndex] !== undefined)
            throw new StateAlreadyExist(`stateID: ${createIndex}`);
        const postState = State.new(pubkeyID, tokenID, balance, 0);
        const proof = this.getProofAndUpdate(createIndex, postState);
        return proof;
    }
}
