const { buildHelper } = require('../helpers/controller')(web3, artifacts)
const { assertRevert } = require('../helpers/assertThrow')

const CRVoting = artifacts.require('CRVoting')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

contract('CRVoting initialization', ([_, someone]) => {
  let controller

  beforeEach('create base contracts', async () => {
    controller = await buildHelper().deploy()
  })

  describe('constructor', () => {
    context('when the initialization succeeds', () => {
      it('initializes voting correctly', async () => {
        const voting = await CRVoting.new(controller.address)

        assert.equal(await voting.getController(), controller.address, 'subscriptions controller does not match')
      })
    })

    context('initialization fails', () => {
      context('when the given controller is the zero address', () => {
        const controllerAddress = ZERO_ADDRESS

        it('reverts', async () => {
          await assertRevert(CRVoting.new(controllerAddress), 'CTD_CONTROLLER_NOT_CONTRACT')
        })
      })

      context('when the given controller is not a contract address', () => {
        const controllerAddress = someone

        it('reverts', async () => {
          await assertRevert(CRVoting.new(controllerAddress), 'CTD_CONTROLLER_NOT_CONTRACT')
        })
      })
    })
  })
})
