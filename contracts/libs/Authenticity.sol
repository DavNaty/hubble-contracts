pragma solidity ^0.5.15;
pragma experimental ABIEncoderV2;

import { Types } from "./Types.sol";
import { MerkleTree } from "../libs/MerkleTree.sol";
import { Tx } from "./Tx.sol";
import { BLS } from "./BLS.sol";

library Authenticity {
    using Tx for bytes;
    using Types for Types.UserState;

    function verifyTransfer(
        uint256[2] memory signature,
        Types.SignatureProof memory proof,
        bytes32 stateRoot,
        bytes32 accountRoot,
        bytes32 domain,
        bytes memory txs
    ) internal view returns (Types.Result) {
        uint256 size = txs.transferSize();
        uint256[2][] memory messages = new uint256[2][](size);
        for (uint256 i = 0; i < size; i++) {
            Tx.Transfer memory _tx = txs.transferDecode(i);
            // check state inclusion
            require(
                MerkleTree.verify(
                    stateRoot,
                    keccak256(proof.states[i].encode()),
                    _tx.fromIndex,
                    proof.stateWitnesses[i]
                ),
                "Rollup: state inclusion signer"
            );

            // check pubkey inclusion
            require(
                MerkleTree.verify(
                    accountRoot,
                    keccak256(abi.encodePacked(proof.pubkeys[i])),
                    proof.states[i].pubkeyIndex,
                    proof.pubkeyWitnesses[i]
                ),
                "Rollup: account does not exists"
            );

            // construct the message
            require(proof.states[i].nonce > 0, "Rollup: zero nonce");
            bytes memory txMsg = Tx.transferMessageOf(
                _tx,
                proof.states[i].nonce - 1
            );
            // make the message
            messages[i] = BLS.hashToPoint(domain, txMsg);
        }
        if (!BLS.verifyMultiple(signature, proof.pubkeys, messages)) {
            return Types.Result.BadSignature;
        }
        return Types.Result.Ok;
    }

    function verifyMassMigration(
        uint256[2] memory signature,
        Types.SignatureProof memory proof,
        bytes32 stateRoot,
        bytes32 accountRoot,
        bytes32 domain,
        uint256 spokeID,
        bytes memory txs
    ) internal view returns (Types.Result) {
        uint256 size = txs.massMigrationSize();
        uint256[2][] memory messages = new uint256[2][](size);
        for (uint256 i = 0; i < size; i++) {
            Tx.MassMigration memory _tx = txs.massMigrationDecode(i);
            // check state inclusion
            require(
                MerkleTree.verify(
                    stateRoot,
                    keccak256(proof.states[i].encode()),
                    _tx.fromIndex,
                    proof.stateWitnesses[i]
                ),
                "Rollup: state inclusion signer"
            );

            // check pubkey inclusion
            require(
                MerkleTree.verify(
                    accountRoot,
                    keccak256(abi.encodePacked(proof.pubkeys[i])),
                    proof.states[i].pubkeyIndex,
                    proof.pubkeyWitnesses[i]
                ),
                "Rollup: account does not exists"
            );

            // construct the message
            require(proof.states[i].nonce > 0, "Rollup: zero nonce");
            bytes memory txMsg = Tx.massMigrationMessageOf(
                _tx,
                proof.states[i].nonce - 1,
                spokeID
            );
            // make the message
            messages[i] = BLS.hashToPoint(domain, txMsg);
        }
        if (!BLS.verifyMultiple(signature, proof.pubkeys, messages)) {
            return Types.Result.BadSignature;
        }
        return Types.Result.Ok;
    }

    function verifyCreate2Transfer(
        uint256[2] memory signature,
        Types.SignatureProofWithReceiver memory proof,
        bytes32 stateRoot,
        bytes32 accountRoot,
        bytes32 domain,
        bytes memory txs
    ) internal view returns (Types.Result) {
        uint256 size = txs.create2TransferSize();
        uint256[2][] memory messages = new uint256[2][](size);
        for (uint256 i = 0; i < size; i++) {
            Tx.Create2Transfer memory _tx = txs.create2TransferDecode(i);

            // check state inclusion
            require(
                MerkleTree.verify(
                    stateRoot,
                    keccak256(proof.states[i].encode()),
                    _tx.fromIndex,
                    proof.stateWitnesses[i]
                ),
                "Rollup: state inclusion signer"
            );

            // check pubkey inclusion
            require(
                MerkleTree.verify(
                    accountRoot,
                    keccak256(abi.encodePacked(proof.pubkeysSender[i])),
                    proof.states[i].pubkeyIndex,
                    proof.pubkeyWitnessesSender[i]
                ),
                "Rollup: from account does not exists"
            );

            // check receiver pubkye inclusion at committed accID
            require(
                MerkleTree.verify(
                    accountRoot,
                    keccak256(abi.encodePacked(proof.pubkeysReceiver[i])),
                    _tx.toAccID,
                    proof.pubkeyWitnessesReceiver[i]
                ),
                "Rollup: to account does not exists"
            );

            // construct the message
            require(proof.states[i].nonce > 0, "Rollup: zero nonce");

            bytes memory txMsg = Tx.create2TransferMessageOf(
                _tx,
                proof.states[i].nonce - 1,
                proof.pubkeysSender[i],
                proof.pubkeysReceiver[i]
            );

            // make the message
            messages[i] = BLS.hashToPoint(domain, txMsg);
        }

        if (!BLS.verifyMultiple(signature, proof.pubkeysSender, messages)) {
            return Types.Result.BadSignature;
        }
        return Types.Result.Ok;
    }
}
