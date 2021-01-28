// SPDX-License-Identifier: MIT
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;
import { Types } from "./libs/Types.sol";
import { ITokenRegistry } from "./TokenRegistry.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Rollup } from "./rollup/Rollup.sol";

interface IDepositManager {
    event DepositQueued(uint256 pubkeyID, bytes data);
    event DepositSubTreeReady(bytes32 root);

    function dequeueToSubmit() external returns (bytes32 subtreeRoot);

    function reenqueue(bytes32 subtreeRoot) external;
}

contract SubtreeQueue {
    // Each element of the queue is a root of a subtree of deposits.
    mapping(uint256 => bytes32) public queue;
    uint256 public front = 1;
    uint256 public back = 0;

    function enqueue(bytes32 subtreeRoot) internal {
        back += 1;
        queue[back] = subtreeRoot;
    }

    function dequeue() internal returns (bytes32 subtreeRoot) {
        require(back >= front, "Deposit Core: Queue should be non-empty");
        subtreeRoot = queue[front];
        delete queue[front];
        front += 1;
    }
}

contract DepositCore is SubtreeQueue {
    // An element is a deposit tree root of any depth.
    // It could be just a leaf of a new deposit or
    // a root of a full grown subtree.
    mapping(uint256 => bytes32) public babyTrees;
    uint256 public babyTreesLength = 0;

    uint256 public depositCount = 0;

    uint256 public paramMaxSubtreeSize = 2;

    function insertAndMerge(bytes32 depositLeaf)
        internal
        returns (bytes32 readySubtree)
    {
        depositCount++;
        uint256 i = depositCount;

        uint256 len = babyTreesLength;
        babyTrees[len] = depositLeaf;
        len++;
        // As long as we have a pair to merge, we merge
        // the number of iteration is bounded by maxSubtreeDepth
        while (i & 1 == 0) {
            // Override the left node with the merged left and right nodes
            babyTrees[len - 2] = keccak256(
                abi.encode(babyTrees[len - 2], babyTrees[len - 1])
            );
            len--;
            i >>= 1;
        }
        babyTreesLength = len;
        // Subtree is ready, send to SubtreeQueue
        if (depositCount == paramMaxSubtreeSize) {
            readySubtree = babyTrees[0];
            enqueue(readySubtree);
            // reset
            babyTreesLength = 0;
            depositCount = 0;
        } else {
            readySubtree = bytes32(0);
        }
    }
}

contract DepositManager is DepositCore, IDepositManager {
    using Types for Types.UserState;
    address public vault;
    address public rollup;

    ITokenRegistry public tokenRegistry;

    modifier onlyRollup() {
        require(
            msg.sender == rollup,
            "DepositManager: sender is not Rollup contract"
        );
        _;
    }

    constructor(
        ITokenRegistry _tokenRegistry,
        address _vault,
        uint256 maxSubtreeDepth
    ) public {
        tokenRegistry = _tokenRegistry;
        vault = _vault;
        paramMaxSubtreeSize = 1 << maxSubtreeDepth;
    }

    function setRollupAddress(address _rollup) public {
        rollup = _rollup;
    }

    /**
     * @notice Adds a deposit for an address to the deposit queue
     * @param amount Number of tokens that user wants to deposit
     * @param tokenID Type of token user is depositing
     */
    function depositFor(
        uint256 pubkeyID,
        uint256 amount,
        uint256 tokenID
    ) external {
        // check amount is greater than 0
        require(amount > 0, "token deposit must be greater than 0");
        IERC20 tokenContract = IERC20(tokenRegistry.safeGetAddress(tokenID));
        // transfer from msg.sender to vault
        require(
            tokenContract.allowance(msg.sender, address(this)) >= amount,
            "token allowance not approved"
        );
        require(
            tokenContract.transferFrom(msg.sender, vault, amount),
            "token transfer not approved"
        );
        // create a new state
        Types.UserState memory newState = Types.UserState(
            pubkeyID,
            tokenID,
            amount,
            0
        );
        // get new state hash
        bytes memory encodedState = newState.encode();
        emit DepositQueued(pubkeyID, encodedState);
        bytes32 readySubtree = insertAndMerge(keccak256(encodedState));
        if (readySubtree != bytes32(0)) {
            emit DepositSubTreeReady(readySubtree);
        }
    }

    function dequeueToSubmit()
        external
        override
        onlyRollup
        returns (bytes32 subtreeRoot)
    {
        return dequeue();
    }

    function reenqueue(bytes32 subtreeRoot) external override onlyRollup {
        enqueue(subtreeRoot);
    }
}
