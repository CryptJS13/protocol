const TruffleAssert = require("truffle-assertions");
const { assert } = require("chai");
const { didContractThrow, interfaceName, RegistryRolesEnum } = require("@uma/common");
const SinkOracle = artifacts.require("SinkOracle");
const Finder = artifacts.require("Finder");
const Registry = artifacts.require("Registry");
const Bridge = artifacts.require("Bridge");
const GenericHandler = artifacts.require("GenericHandler");

const { utf8ToHex, hexToUtf8, padRight } = web3.utils;

const { blankFunctionSig, createGenericDepositData } = require("./helpers");

contract("SinkOracle", async accounts => {
  let sinkOracle;
  let registry;
  let finder;
  let bridge;
  let handler;

  const chainID = 1;
  const destinationChainID = 2;
  const testIdentifier = utf8ToHex("TEST-IDENTIFIER");
  const testAncillary = utf8ToHex("TEST-ANCILLARY");
  const testRequestTime = 123;
  const testPrice = "6";
  const expectedDepositNonce = 1;

  let sinkOracleResourceId;

  before(async function() {
    registry = await Registry.deployed();
    await registry.addMember(RegistryRolesEnum.CONTRACT_CREATOR, accounts[0]);
    await registry.registerContract([], accounts[0], { from: accounts[0] });
  });
  beforeEach(async function() {
    finder = await Finder.deployed();
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.Registry), registry.address);
    bridge = await Bridge.new(chainID, [accounts[0]], 1, 0, 100);
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.Bridge), bridge.address);
    sinkOracle = await SinkOracle.new(finder.address, chainID, destinationChainID);
    sinkOracleResourceId = await sinkOracle.getResourceId();
    handler = await GenericHandler.new(
      bridge.address,
      [sinkOracleResourceId],
      [sinkOracle.address],
      [blankFunctionSig],
      [blankFunctionSig]
    );
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.GenericHandler), handler.address);
    await bridge.adminSetGenericResource(
      handler.address,
      sinkOracleResourceId,
      sinkOracle.address,
      blankFunctionSig,
      blankFunctionSig,
      { from: accounts[0] }
    );
  });
  it("construction", async function() {
    assert.equal(await sinkOracle.destinationChainID(), destinationChainID.toString(), "destination chain ID not set");
  });
  it("requestPrice: should call Bridge.deposit", async function() {
    assert(
      await didContractThrow(
        sinkOracle.requestPrice(testIdentifier, testRequestTime, testAncillary, { from: accounts[1] })
      ),
      "Only callable by registered contract"
    );
    const txn = await sinkOracle.requestPrice(testIdentifier, testRequestTime, testAncillary, { from: accounts[0] });
    TruffleAssert.eventEmitted(
      txn,
      "PriceRequestAdded",
      event =>
        event.requester.toLowerCase() === accounts[0].toLowerCase() &&
        hexToUtf8(event.identifier) === hexToUtf8(testIdentifier) &&
        event.time.toString() === testRequestTime.toString() &&
        event.ancillaryData.toLowerCase() === testAncillary.toLowerCase()
    );

    // Deposit event will be emitted after successful Bridge.deposit() internal call if the resource ID is set up
    // properly.
    const internalTxn = await TruffleAssert.createTransactionResult(bridge, txn.tx);
    TruffleAssert.eventEmitted(
      internalTxn,
      "Deposit",
      event =>
        event.destinationChainID.toString() === destinationChainID.toString() &&
        event.resourceID.toLowerCase() === sinkOracleResourceId.toLowerCase() &&
        event.depositNonce.toString() === expectedDepositNonce.toString()
    );
  });
  it("validateDeposit", async function() {
    assert(
      await didContractThrow(sinkOracle.validateDeposit(testIdentifier, testRequestTime, testAncillary)),
      "Reverts if price not requested yet"
    );
    await sinkOracle.requestPrice(testIdentifier, testRequestTime, testAncillary, { from: accounts[0] });
    await sinkOracle.validateDeposit(testIdentifier, testRequestTime, testAncillary);
  });
  it("publishPrice", async function() {
    await sinkOracle.requestPrice(testIdentifier, testRequestTime, testAncillary, { from: accounts[0] });
    assert(
      await didContractThrow(
        sinkOracle.publishPrice(testIdentifier, testRequestTime, testAncillary, { from: accounts[1] })
      ),
      "Only callable by GenericHandler"
    );
    await finder.changeImplementationAddress(utf8ToHex(interfaceName.GenericHandler), accounts[1]);
    await sinkOracle.publishPrice(testIdentifier, testRequestTime, testAncillary, testPrice, { from: accounts[1] });
    assert.isTrue(await sinkOracle.hasPrice(testIdentifier, testRequestTime, testAncillary));
  });
  it("formatMetadata", async function() {
    const metadata = await sinkOracle.formatMetadata(testIdentifier, testRequestTime, testAncillary);
    const encoded = web3.eth.abi.encodeParameters(
      ["bytes32", "uint256", "bytes"],
      [padRight(testIdentifier, 64), testRequestTime, testAncillary]
    );
    const formattedEncoded = createGenericDepositData(encoded);
    assert.equal(metadata, formattedEncoded);
  });
});