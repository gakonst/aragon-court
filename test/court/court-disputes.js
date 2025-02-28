const { bn, bigExp } = require('../helpers/numbers')
const { assertRevert } = require('../helpers/assertThrow')
const { NEXT_WEEK, ONE_DAY } = require('../helpers/time')
const { decodeEventsOfType } = require('../helpers/decodeEvent')
const { buildHelper, DISPUTE_STATES } = require('../helpers/court')(web3, artifacts)
const { assertAmountOfEvents, assertEvent } = require('../helpers/assertEvent')

const ERC20 = artifacts.require('ERC20Mock')
const CourtClock = artifacts.require('CourtClock')
const Arbitrable = artifacts.require('ArbitrableMock')

contract('Court', ([_, sender]) => {
  let courtHelper, court, feeToken, arbitrable

  const termDuration = bn(ONE_DAY)
  const firstTermStartTime = bn(NEXT_WEEK)
  const jurorFee = bigExp(10, 18)
  const draftFee = bigExp(30, 18)
  const settleFee = bigExp(40, 18)
  const firstRoundJurorsNumber = 5

  beforeEach('create court', async () => {
    courtHelper = buildHelper()
    feeToken = await ERC20.new('Court Fee Token', 'CFT', 18)
    court = await courtHelper.deploy({ firstTermStartTime, termDuration, feeToken, jurorFee, draftFee, settleFee, firstRoundJurorsNumber })
  })

  beforeEach('mock subscriptions and arbitrable instance', async () => {
    arbitrable = await Arbitrable.new()
    await courtHelper.subscriptions.setUpToDate(true)
  })

  describe('createDispute', () => {
    beforeEach('set timestamp at the beginning of the first term', async () => {
      await courtHelper.setTimestamp(firstTermStartTime)
    })

    context('when the given input is valid', () => {
      const draftTermId = 2
      const possibleRulings = 2

      const itHandlesDisputesCreationProperly = expectedTermTransitions => {
        context('when the creator approves enough fee tokens', () => {
          beforeEach('approve fee amount', async () => {
            const { disputeFees } = await courtHelper.getDisputeFees(draftTermId)
            await courtHelper.mintAndApproveFeeTokens(sender, court.address, disputeFees)
          })

          it('creates a new dispute', async () => {
            // move forward to the term before the desired start one for the dispute
            await courtHelper.setTerm(draftTermId - 1)
            const receipt = await court.createDispute(arbitrable.address, possibleRulings, { from: sender })

            assertAmountOfEvents(receipt, 'NewDispute')
            assertEvent(receipt, 'NewDispute', { disputeId: 0, subject: arbitrable.address, draftTermId, jurorsNumber: firstRoundJurorsNumber })

            const { subject, possibleRulings: rulings, state, finalRuling } = await courtHelper.getDispute(0)
            assert.equal(subject, arbitrable.address, 'dispute subject does not match')
            assert.equal(state.toString(), DISPUTE_STATES.PRE_DRAFT.toString(), 'dispute state does not match')
            assert.equal(rulings.toString(), possibleRulings, 'dispute possible rulings do not match')
            assert.equal(finalRuling.toString(), 0, 'dispute final ruling does not match')
          })

          it('creates a new adjudication round', async () => {
            // move forward to the term before the desired start one for the dispute
            await courtHelper.setTerm(draftTermId - 1)
            await court.createDispute(arbitrable.address, possibleRulings, { from: sender })

            const { draftTerm, delayedTerms, roundJurorsNumber, selectedJurors, jurorFees, triggeredBy, settledPenalties, collectedTokens } = await courtHelper.getRound(0, 0)

            assert.equal(draftTerm.toString(), draftTermId, 'round draft term does not match')
            assert.equal(delayedTerms.toString(), 0, 'round delay term does not match')
            assert.equal(roundJurorsNumber.toString(), firstRoundJurorsNumber, 'round jurors number does not match')
            assert.equal(selectedJurors.toString(), 0, 'round selected jurors number does not match')
            assert.equal(jurorFees.toString(), courtHelper.jurorFee.mul(bn(firstRoundJurorsNumber)).toString(), 'round juror fees do not match')
            assert.equal(triggeredBy, sender, 'round trigger does not match')
            assert.equal(settledPenalties, false, 'round penalties should not be settled')
            assert.equal(collectedTokens.toString(), 0, 'round collected tokens should be zero')
          })

          it('transfers fees to the court', async () => {
            // move forward to the term before the desired start one for the dispute
            await courtHelper.setTerm(draftTermId - 1)
            const { disputeFees: expectedDisputeDeposit } = await courtHelper.getDisputeFees(draftTermId)
            const previousCourtBalance = await feeToken.balanceOf(court.address)
            const previousTreasuryBalance = await feeToken.balanceOf(courtHelper.treasury.address)
            const previousSenderBalance = await feeToken.balanceOf(sender)

            await court.createDispute(arbitrable.address, possibleRulings, { from: sender })

            const currentCourtBalance = await feeToken.balanceOf(court.address)
            assert.equal(previousCourtBalance.toString(), currentCourtBalance.toString(), 'court balances do not match')

            const currentTreasuryBalance = await feeToken.balanceOf(courtHelper.treasury.address)
            assert.equal(previousTreasuryBalance.add(expectedDisputeDeposit).toString(), currentTreasuryBalance.toString(), 'court treasury balances do not match')

            const currentSenderBalance = await feeToken.balanceOf(sender)
            assert.equal(previousSenderBalance.sub(expectedDisputeDeposit).toString(), currentSenderBalance.toString(), 'sender balances do not match')
          })

          it(`transitions ${expectedTermTransitions} terms`, async () => {
            const previousTermId = await courtHelper.controller.getLastEnsuredTermId()

            const receipt = await court.createDispute(arbitrable.address, possibleRulings, { from: sender })

            const logs = decodeEventsOfType(receipt, CourtClock.abi, 'Heartbeat')
            assertAmountOfEvents({ logs }, 'Heartbeat', expectedTermTransitions)

            const currentTermId = await courtHelper.controller.getLastEnsuredTermId()
            assert.equal(previousTermId.add(bn(expectedTermTransitions)).toString(), currentTermId.toString(), 'term id does not match')
          })
        })

        context('when the creator does not have enough fee tokens approved', () => {
          it('reverts', async () => {
            await assertRevert(court.createDispute(arbitrable.address, possibleRulings), 'CT_DEPOSIT_FAILED')
          })
        })
      }

      context('when the term is up-to-date', () => {
        const expectedTermTransitions = 0

        beforeEach('move right before the desired draft term', async () => {
          await courtHelper.controller.heartbeat(1)
        })

        itHandlesDisputesCreationProperly(expectedTermTransitions)
      })

      context('when the term is outdated by one term', () => {
        const expectedTermTransitions = 1

        itHandlesDisputesCreationProperly(expectedTermTransitions)
      })

      context('when the term is outdated by more than one term', () => {
        beforeEach('set timestamp two terms after the first term', async () => {
          await courtHelper.setTimestamp(firstTermStartTime.add(termDuration.mul(bn(2))))
        })

        it('reverts', async () => {
          await assertRevert(court.createDispute(arbitrable.address, possibleRulings), 'CLK_TOO_MANY_TRANSITIONS')
        })
      })
    })

    context('when the given input is not valid', () => {
      context('when the possible rulings are invalid', () => {
        it('reverts', async () => {
          await assertRevert(court.createDispute(arbitrable.address, 0), 'CT_INVALID_RULING_OPTIONS')
          await assertRevert(court.createDispute(arbitrable.address, 1), 'CT_INVALID_RULING_OPTIONS')
          await assertRevert(court.createDispute(arbitrable.address, 3), 'CT_INVALID_RULING_OPTIONS')
        })
      })

      context('when the subscription is outdated', () => {
        it('reverts', async () => {
          await courtHelper.subscriptions.setUpToDate(false)

          await assertRevert(court.createDispute(arbitrable.address, 2), 'CT_SUBSCRIPTION_NOT_PAID')
        })
      })

      context('when the arbitrable is not valid', () => {
        // TODO: implement
      })
    })
  })

  describe('getDispute', () => {
    context('when the dispute exists', async () => {
      const draftTermId = 2
      const possibleRulings = 2

      beforeEach('create dispute', async () => {
        const { disputeFees } = await courtHelper.getDisputeFees(draftTermId)
        await courtHelper.mintAndApproveFeeTokens(sender, court.address, disputeFees)

        // move forward to the term before the desired start one for the dispute
        await courtHelper.setTerm(draftTermId - 1)
        await court.createDispute(arbitrable.address, possibleRulings, { from: sender })
      })

      it('returns the requested dispute', async () => {
        const { subject, possibleRulings: rulings, state, finalRuling } = await courtHelper.getDispute(0)

        assert.equal(subject, arbitrable.address, 'dispute subject does not match')
        assert.equal(state.toString(), DISPUTE_STATES.PRE_DRAFT.toString(), 'dispute state does not match')
        assert.equal(rulings.toString(), possibleRulings, 'dispute possible rulings do not match')
        assert.equal(finalRuling.toString(), 0, 'dispute final ruling does not match')
      })
    })

    context('when the given dispute does not exist', () => {
      it('reverts', async () => {
        await assertRevert(court.getDispute(0), 'CT_DISPUTE_DOES_NOT_EXIST')
      })
    })
  })

  describe('getRound', () => {
    context('when the dispute exists', async () => {
      const draftTermId = 2
      const possibleRulings = 2

      beforeEach('create dispute', async () => {
        const { disputeFees } = await courtHelper.getDisputeFees(draftTermId)
        await courtHelper.mintAndApproveFeeTokens(sender, court.address, disputeFees)

        // move forward to the term before the desired start one for the dispute
        await courtHelper.setTerm(draftTermId - 1)
        await court.createDispute(arbitrable.address, possibleRulings, { from: sender })
      })

      context('when the given round is valid', async () => {
        it('returns the requested round', async () => {
          const { draftTerm, delayedTerms, roundJurorsNumber, selectedJurors, jurorFees, triggeredBy, settledPenalties, collectedTokens } = await courtHelper.getRound(0, 0)

          assert.equal(draftTerm.toString(), draftTermId, 'round draft term does not match')
          assert.equal(delayedTerms.toString(), 0, 'round delay term does not match')
          assert.equal(roundJurorsNumber.toString(), firstRoundJurorsNumber, 'round jurors number does not match')
          assert.equal(selectedJurors.toString(), 0, 'round selected jurors number does not match')
          assert.equal(jurorFees.toString(), courtHelper.jurorFee.mul(bn(firstRoundJurorsNumber)).toString(), 'round juror fees do not match')
          assert.equal(triggeredBy, sender, 'round trigger does not match')
          assert.equal(settledPenalties, false, 'round penalties should not be settled')
          assert.equal(collectedTokens.toString(), 0, 'round collected tokens should be zero')
        })
      })

      context('when the given round is not valid', async () => {
        it('reverts', async () => {
          await assertRevert(court.getRound(0, 1), 'CT_ROUND_DOES_NOT_EXIST')
        })
      })
    })

    context('when the given dispute does not exist', () => {
      it('reverts', async () => {
        await assertRevert(court.getRound(0, 0), 'CT_DISPUTE_DOES_NOT_EXIST')
      })
    })
  })
})
