const { assertBn } = require('../helpers/numbers')
const { bn, bigExp } = require('../helpers/numbers')
const { assertRevert } = require('../helpers/assertThrow')
const { advanceBlocks } = require('../helpers/blocks')(web3)
const { toChecksumAddress } = require('web3-utils')
const { decodeEventsOfType } = require('../helpers/decodeEvent')
const { getEventAt, getEvents } = require('@aragon/os/test/helpers/events')
const { assertAmountOfEvents, assertEvent } = require('../helpers/assertEvent')
const { buildHelper, DISPUTE_STATES, ROUND_STATES } = require('../helpers/court')(web3, artifacts)

const JurorsRegistry = artifacts.require('JurorsRegistry')

contract('Court', ([_, disputer, drafter, juror500, juror1000, juror1500, juror2000, configGovernor, someone]) => {
  let courtHelper, court

  const firstRoundJurorsNumber = 5
  const jurors = [
    { address: juror500,  initialActiveBalance: bigExp(500,  18) },
    { address: juror1000, initialActiveBalance: bigExp(1000, 18) },
    { address: juror1500, initialActiveBalance: bigExp(1500, 18) },
    { address: juror2000, initialActiveBalance: bigExp(2000, 18) },
  ]

  beforeEach('create court', async () => {
    courtHelper = buildHelper()
    court = await courtHelper.deploy({ configGovernor, firstRoundJurorsNumber })
  })

  describe('draft', () => {
    context('when the given dispute exists', () => {
      let disputeId

      const roundId = 0
      const draftTermId = 4

      beforeEach('create dispute', async () => {
        await courtHelper.activate(jurors)
        disputeId = await courtHelper.dispute({ draftTermId, disputer })
      })

      const itDraftsRequestedRoundInOneBatch = (term, jurorsToBeDrafted) => {
        const expectedDraftedJurors = jurorsToBeDrafted > firstRoundJurorsNumber ? firstRoundJurorsNumber : jurorsToBeDrafted

        it('selects random jurors for the last round of the dispute', async () => {
          const receipt = await court.draft(disputeId, { from: drafter })

          const logs = decodeEventsOfType(receipt, JurorsRegistry.abi, 'JurorDrafted')
          assertAmountOfEvents({ logs }, 'JurorDrafted', expectedDraftedJurors)

          const jurorsAddresses = jurors.map(j => j.address)
          for(let i = 0; i < expectedDraftedJurors; i++) {
            const { disputeId: eventDisputeId, juror } = getEventAt({ logs }, 'JurorDrafted', i).args
            assert.equal(eventDisputeId.toString(), disputeId, 'dispute id does not match')
            assert.isTrue(jurorsAddresses.includes(toChecksumAddress(juror)), 'drafted juror is not included in the list')
          }
        })

        if (expectedDraftedJurors === firstRoundJurorsNumber) {
          it('ends the dispute draft', async () => {
            const receipt = await court.draft(disputeId, { from: drafter })

            assertAmountOfEvents(receipt, 'DisputeStateChanged')
            assertEvent(receipt, 'DisputeStateChanged', { disputeId, state: DISPUTE_STATES.ADJUDICATING })

            const { state, finalRuling } = await courtHelper.getDispute(disputeId)
            assert.equal(state.toString(), DISPUTE_STATES.ADJUDICATING.toString(), 'dispute state does not match')
            assert.equal(finalRuling.toString(), 0, 'dispute final ruling does not match')
          })

          it('updates last round information', async () => {
            await court.draft(disputeId, { from: drafter })

            const { draftTerm, delayedTerms, roundJurorsNumber, selectedJurors, jurorFees, roundState } = await courtHelper.getRound(disputeId, roundId)
            assert.equal(draftTerm.toString(), draftTermId, 'round draft term does not match')
            assert.equal(delayedTerms.toString(), term - draftTermId, 'delayed terms do not match')
            assert.equal(roundJurorsNumber.toString(), firstRoundJurorsNumber, 'round jurors number does not match')
            assert.equal(selectedJurors.toString(), firstRoundJurorsNumber, 'selected jurors does not match')
            assert.equal(jurorFees.toString(), courtHelper.jurorFee.mul(bn(firstRoundJurorsNumber)).toString(), 'round juror fees do not match')
            assert.equal(roundState.toString(), ROUND_STATES.COMMITTING.toString(), 'round state should be committing')
          })
        } else {
          it('does not end the dispute draft', async () => {
            const receipt = await court.draft(disputeId, { from: drafter })

            assertAmountOfEvents(receipt, 'DisputeStateChanged', 0)

            const { state, finalRuling } = await courtHelper.getDispute(disputeId)
            assert.equal(state.toString(), DISPUTE_STATES.PRE_DRAFT.toString(), 'dispute state does not match')
            assert.equal(finalRuling.toString(), 0, 'dispute final ruling does not match')
          })

          it('updates last round information', async () => {
            await court.draft(disputeId, { from: drafter })

            const { draftTerm, delayedTerms, roundJurorsNumber, selectedJurors, jurorFees, roundState } = await courtHelper.getRound(disputeId, roundId)
            assert.equal(draftTerm.toString(), draftTermId, 'round draft term does not match')
            assert.equal(delayedTerms.toString(), 0, 'delayed terms do not match')
            assert.equal(roundJurorsNumber.toString(), firstRoundJurorsNumber, 'round jurors number does not match')
            assert.equal(selectedJurors.toString(), expectedDraftedJurors, 'selected jurors does not match')
            assert.equal(jurorFees.toString(), courtHelper.jurorFee.mul(bn(firstRoundJurorsNumber)).toString(), 'round juror fees do not match')
            assert.equal(roundState.toString(), ROUND_STATES.INVALID.toString(), 'round state should be committing')
          })
        }

        it('sets the correct state for each juror', async () => {
          const receipt = await court.draft(disputeId, { from: drafter })

          const logs = decodeEventsOfType(receipt, JurorsRegistry.abi, 'JurorDrafted')
          const events = getEvents({ logs }, 'JurorDrafted')

          for(let i = 0; i < jurors.length; i++) {
            const jurorAddress = jurors[i].address
            const expectedWeight = events.filter(({ args: { juror } }) => toChecksumAddress(juror) === jurorAddress).length
            const { weight, rewarded } = await courtHelper.getRoundJuror(disputeId, roundId, jurorAddress)

            assert.equal(weight.toString(), expectedWeight, 'juror weight does not match')
            assert.isFalse(rewarded, 'juror should not have been rewarded yet')
          }
        })

        it('deposits the draft fee to the treasury for the caller', async () => {
          const { draftFee, treasury, feeToken } = courtHelper
          const expectedFee = draftFee.mul(bn(expectedDraftedJurors))

          const previousCourtAmount = await feeToken.balanceOf(court.address)
          const previousTreasuryAmount = await feeToken.balanceOf(treasury.address)
          const previousDrafterAmount = await treasury.balanceOf(feeToken.address, drafter)

          await court.draft(disputeId, { from: drafter })

          const currentCourtAmount = await feeToken.balanceOf(court.address)
          assert.equal(previousCourtAmount.toString(), currentCourtAmount.toString(), 'court balances should remain the same')

          const currentTreasuryAmount = await feeToken.balanceOf(treasury.address)
          assert.equal(previousTreasuryAmount.toString(), currentTreasuryAmount.toString(), 'treasury balances should remain the same')

          const currentDrafterAmount = await treasury.balanceOf(feeToken.address, drafter)
          assert.equal(previousDrafterAmount.add(expectedFee).toString(), currentDrafterAmount.toString(), 'drafter amount does not match')
        })
      }

      const itDraftsRequestedRoundInMultipleBatches = (term, jurorsToBeDrafted, batches, jurorsPerBatch) => {
        it('selects random jurors for the last round of the dispute', async () => {
          const jurorsAddresses = jurors.map(j => j.address)

          for (let batch = 0, selectedJurors = 0; batch < batches; batch++, selectedJurors += jurorsPerBatch) {
            const receipt = await court.draft(disputeId, { from: drafter })

            const pendingJurorsToBeDrafted = jurorsToBeDrafted - selectedJurors
            const expectedDraftedJurors = pendingJurorsToBeDrafted < jurorsPerBatch ? pendingJurorsToBeDrafted : jurorsPerBatch

            const logs = decodeEventsOfType(receipt, JurorsRegistry.abi, 'JurorDrafted')
            assertAmountOfEvents({ logs }, 'JurorDrafted', expectedDraftedJurors)

            for(let i = 0; i < expectedDraftedJurors; i++) {
              const { disputeId: eventDisputeId, juror } = getEventAt({ logs }, 'JurorDrafted', i).args
              assert.equal(eventDisputeId.toString(), disputeId, 'dispute id does not match')
              assert.isTrue(jurorsAddresses.includes(toChecksumAddress(juror)), 'drafted juror is not included in the list')
            }

            // advance one term to avoid drafting all the batches in the same term
            if (batch + 1 < batches) await courtHelper.passRealTerms(1)
          }
        })

        it('ends the dispute draft', async () => {
          let lastReceipt
          for (let batch = 0; batch < batches; batch++) {
            lastReceipt = await court.draft(disputeId, { from: drafter })

            // advance one term to avoid drafting all the batches in the same term
            if (batch + 1 < batches) await courtHelper.passRealTerms(1)
          }

          assertAmountOfEvents(lastReceipt, 'DisputeStateChanged')
          assertEvent(lastReceipt, 'DisputeStateChanged', { disputeId, state: DISPUTE_STATES.ADJUDICATING })

          const { state, finalRuling } = await courtHelper.getDispute(disputeId)
          assert.equal(state.toString(), DISPUTE_STATES.ADJUDICATING.toString(), 'dispute state does not match')
          assert.equal(finalRuling.toString(), 0, 'dispute final ruling does not match')
        })

        it('updates last round information', async () => {
          let lastTerm
          for (let batch = 0; batch < batches; batch++) {
            await court.draft(disputeId, { from: drafter })
            lastTerm = await courtHelper.controller.getLastEnsuredTermId()

            // advance one term to avoid drafting all the batches in the same term
            if (batch + 1 < batches) await courtHelper.passRealTerms(1)
          }

          const { draftTerm, delayedTerms, roundJurorsNumber, selectedJurors, jurorFees, roundState } = await courtHelper.getRound(disputeId, roundId)

          assert.equal(draftTerm.toString(), draftTermId, 'round draft term does not match')
          assert.equal(delayedTerms.toString(), lastTerm - draftTermId, 'delayed terms do not match')
          assert.equal(roundJurorsNumber.toString(), firstRoundJurorsNumber, 'round jurors number does not match')
          assert.equal(selectedJurors.toString(), firstRoundJurorsNumber, 'selected jurors does not match')
          assert.equal(jurorFees.toString(), courtHelper.jurorFee.mul(bn(firstRoundJurorsNumber)).toString(), 'round juror fees do not match')
          assert.equal(roundState.toString(), ROUND_STATES.COMMITTING.toString(), 'round state should be committing')
        })

        it('sets the correct state for each juror', async () => {
          const expectedWeights = {}

          for (let batch = 0; batch < batches; batch++) {
            const receipt = await court.draft(disputeId, { from: drafter })

            const logs = decodeEventsOfType(receipt, JurorsRegistry.abi, 'JurorDrafted')
            const events = getEvents({ logs }, 'JurorDrafted')

            for(let i = 0; i < jurors.length; i++) {
              const jurorAddress = jurors[i].address
              const batchWeight = events.filter(({ args: { juror } }) => toChecksumAddress(juror) === jurorAddress).length
              expectedWeights[jurorAddress] = (expectedWeights[jurorAddress] || 0) + batchWeight
            }

            // advance one term to avoid drafting all the batches in the same term
            if (batch + 1 < batches) await courtHelper.passRealTerms(1)
          }

          for(let i = 0; i < jurors.length; i++) {
            const jurorAddress = jurors[i].address
            const { weight, rewarded } = await court.getJuror(disputeId, roundId, jurorAddress)

            assert.equal(weight.toString(), expectedWeights[jurorAddress], `juror ${jurorAddress} weight does not match`)
            assert.isFalse(rewarded, 'juror should not have been rewarded yet')
          }
        })

        it('deposits the draft fee to the treasury for the caller', async () => {
          const { draftFee, treasury, feeToken } = courtHelper

          for (let batch = 0, selectedJurors = 0; batch < batches; batch++, selectedJurors += jurorsPerBatch) {
            const previousCourtAmount = await feeToken.balanceOf(court.address)
            const previousTreasuryAmount = await feeToken.balanceOf(treasury.address)
            const previousDrafterAmount = await treasury.balanceOf(feeToken.address, drafter)

            await court.draft(disputeId, { from: drafter })

            const currentCourtAmount = await feeToken.balanceOf(court.address)
            assert.equal(previousCourtAmount.toString(), currentCourtAmount.toString(), 'court balances should remain the same')

            const currentTreasuryAmount = await feeToken.balanceOf(treasury.address)
            assert.equal(previousTreasuryAmount.toString(), currentTreasuryAmount.toString(), 'treasury balances should remain the same')

            const pendingJurorsToBeDrafted = jurorsToBeDrafted - selectedJurors
            const expectedDraftedJurors = pendingJurorsToBeDrafted < jurorsPerBatch ? pendingJurorsToBeDrafted : jurorsPerBatch
            const expectedFee = draftFee.mul(bn(expectedDraftedJurors))
            const currentDrafterAmount = await treasury.balanceOf(feeToken.address, drafter)
            assert.equal(previousDrafterAmount.add(expectedFee).toString(), currentDrafterAmount.toString(), 'drafter amount does not match')

            // advance one term to avoid drafting all the batches in the same term
            if (batch + 1 < batches) await courtHelper.passRealTerms(1)
          }
        })
      }

      const itHandlesDraftsProperlyForDifferentRequestedJurorsNumber = term => {
        context('when drafting all the requested jurors', () => {
          context('when drafting in one batch', () => {
            const maxJurorsPerDraftBatch = firstRoundJurorsNumber

            beforeEach('set max number of jurors to be drafted per batch', async () => {
              await court.setMaxJurorsPerDraftBatch(maxJurorsPerDraftBatch, { from: configGovernor })
            })

            itDraftsRequestedRoundInOneBatch(term, maxJurorsPerDraftBatch)
          })

          context('when drafting in multiple batches', () => {
            const batches = 2, maxJurorsPerDraftBatch = 4

            beforeEach('set max number of jurors to be drafted per batch', async () => {
              await court.setMaxJurorsPerDraftBatch(maxJurorsPerDraftBatch, { from: configGovernor })
            })

            itDraftsRequestedRoundInMultipleBatches(term, firstRoundJurorsNumber, batches, maxJurorsPerDraftBatch)
          })
        })

        context('when half amount of the requested jurors', () => {
          const maxJurorsPerDraftBatch = Math.floor(firstRoundJurorsNumber / 2)

          beforeEach('set max number of jurors to be drafted per batch', async () => {
            await court.setMaxJurorsPerDraftBatch(maxJurorsPerDraftBatch, { from: configGovernor })
          })

          itDraftsRequestedRoundInOneBatch(term, maxJurorsPerDraftBatch)
        })

        context('when drafting more than the requested jurors', () => {
          const maxJurorsPerDraftBatch = firstRoundJurorsNumber * 2

          beforeEach('set max number of jurors to be drafted per batch', async () => {
            await court.setMaxJurorsPerDraftBatch(maxJurorsPerDraftBatch, { from: configGovernor })
          })

          itDraftsRequestedRoundInOneBatch(term, maxJurorsPerDraftBatch)
        })
      }

      const itHandlesDraftsProperly = term => {
        const advanceBlocksAfterDraftBlockNumber = async blocks => {
          // NOTE: To test this scenario we cannot mock the blocknumber, we need a real block mining to have different blockhashes
          const { randomnessBN } = await courtHelper.controller.getTerm(draftTermId)
          const currentBlockNumber = await courtHelper.controller.getBlockNumberExt()
          const outdatedBlocks = currentBlockNumber.toNumber() - randomnessBN.toNumber()
          if (outdatedBlocks <= blocks) await advanceBlocks(blocks - outdatedBlocks)
        }

        context('when the current block is the randomness block number', () => {
          beforeEach('mock current block number', async () => {
            const { randomnessBN } = await courtHelper.controller.getTerm(draftTermId)
            await courtHelper.controller.mockSetBlockNumber(randomnessBN)
          })

          it('reverts', async () => {
            await assertRevert(court.draft(disputeId, { from: drafter }), 'CLK_TERM_RANDOMNESS_NOT_YET')
          })
        })

        context('when the current block is the following block of the randomness block number', () => {
          // no need to move one block since the `beforeEach` block will hit the next block

          itHandlesDraftsProperlyForDifferentRequestedJurorsNumber(term)
        })

        context('when the current term is after the randomness block number by less than 256 blocks', () => {
          beforeEach('move 15 blocks after the draft term block number', async () => {
            await advanceBlocksAfterDraftBlockNumber(15)
          })

          itHandlesDraftsProperlyForDifferentRequestedJurorsNumber(term)
        })

        context('when the current term is after the randomness block number by 256 blocks', () => {
          beforeEach('move 256 blocks after the draft term block number', async () => {
            // moving 254 blocks instead of 256 since the `beforeEach` block will hit two more blocks
            await advanceBlocksAfterDraftBlockNumber(254)
          })

          itHandlesDraftsProperlyForDifferentRequestedJurorsNumber(term)
        })

        context('when the current term is after the randomness block number by more than 256 blocks', () => {
          beforeEach('move 257 blocks after the draft term block number', async () => {
            await advanceBlocksAfterDraftBlockNumber(257)
          })

          it('reverts', async () => {
            await assertRevert(court.draft(disputeId, { from: drafter }), 'CLK_TERM_RANDOMNESS_UNAVAILABLE')
          })
        })
      }

      const itHandlesDraftsProperlyForTerm = term => {
        beforeEach('move to requested term', async () => {
          // the term previous to the draft term was already ensured when creating the dispute
          await courtHelper.increaseTimeInTerms(term - draftTermId + 1)
        })

        context('when the given dispute was not drafted', () => {
          context('when the court term is up-to-date', () => {
            beforeEach('ensure the draft term', async () => {
              const neededTransitions = await courtHelper.controller.getNeededTermTransitions()
              await courtHelper.controller.heartbeat(neededTransitions)
            })

            itHandlesDraftsProperly(term)
          })

          context('when the court term is outdated by one term', () => {
            beforeEach('ensure previous term of the draft term', async () => {
              const neededTransitions = (await courtHelper.controller.getNeededTermTransitions()).toNumber()
              assert.isAbove(neededTransitions, 0, 'no needed transitions')
              if (neededTransitions > 1) await courtHelper.controller.heartbeat(bn(neededTransitions - 1))
            })

            context('when the heartbeat was not executed', async () => {
              it('reverts', async () => {
                await assertRevert(court.draft(disputeId, { from: drafter }), 'CT_TERM_OUTDATED')
              })
            })

            context('when the heartbeat was executed', async () => {
              let lastEnsuredTermId, previousBalance, receipt

              beforeEach('call heartbeat', async () => {
                lastEnsuredTermId = await courtHelper.controller.getLastEnsuredTermId()
                previousBalance = await courtHelper.treasury.balanceOf(courtHelper.feeToken.address, drafter)
                receipt = await courtHelper.controller.heartbeat(1, { from: drafter })
              })

              it('transitions 1 term', async () => {
                assertAmountOfEvents(receipt, 'Heartbeat', 1)
                assertEvent(receipt, 'Heartbeat', { previousTermId: lastEnsuredTermId, currentTermId: lastEnsuredTermId.add(bn(1)) })
              })

              itHandlesDraftsProperly(term)
            })
          })

          context('when the court term is outdated by more than one term', () => {
            beforeEach('advance some blocks to ensure term randomness', async () => {
              await advanceBlocks(10)
            })

            it('reverts', async () => {
              await assertRevert(court.draft(disputeId, { from: drafter }), 'CT_TERM_OUTDATED')
            })
          })
        })

        context('when the given dispute was already drafted', () => {
          beforeEach('draft dispute', async () => {
            await courtHelper.controller.heartbeat(term)
            await advanceBlocks(10) // advance some blocks to ensure term randomness
            await court.draft(disputeId, { from: drafter })
          })

          it('reverts', async () => {
            await assertRevert(court.draft(disputeId, { from: drafter }), 'CT_ROUND_ALREADY_DRAFTED')
          })
        })
      }

      context('when the current term is previous the draft term', () => {
        it('reverts', async () => {
          await assertRevert(court.draft(disputeId, { from: drafter }), 'CLK_TERM_DOES_NOT_EXIST')
        })
      })

      context('when the current term is the draft term', () => {
        const currentTerm = draftTermId

        itHandlesDraftsProperlyForTerm(currentTerm)
      })

      context('when the current term is after the draft term', () => {
        const currentTerm = draftTermId + 10

        itHandlesDraftsProperlyForTerm(currentTerm)
      })
    })

    context('when the given dispute does not exist', () => {
      it('reverts', async () => {
        await assertRevert(court.draft(0), 'CT_DISPUTE_DOES_NOT_EXIST')
      })
    })
  })

  describe('setMaxJurorsPerDraftBatch', () => {
    context('when the sender is the governor config', () => {
      const from = configGovernor

      context('when the given value is greater than zero', () => {
        const newJurorsPerDraftBatch = bn(20)

        it('updates the max number of jurors per draft batch', async () => {
          await court.setMaxJurorsPerDraftBatch(newJurorsPerDraftBatch, { from })

          const maxJurorsPerDraftBatch = await court.maxJurorsPerDraftBatch()
          assertBn(maxJurorsPerDraftBatch, newJurorsPerDraftBatch, 'Max draft batch size was not properly set')
        })

        it('emits an event', async () => {
          const previousMaxJurorsPerDraftBatch = await court.maxJurorsPerDraftBatch()

          const receipt = await court.setMaxJurorsPerDraftBatch(newJurorsPerDraftBatch, { from })

          assertAmountOfEvents(receipt, 'MaxJurorsPerDraftBatchChanged')
          assertEvent(receipt, 'MaxJurorsPerDraftBatchChanged', { previousMaxJurorsPerDraftBatch, currentMaxJurorsPerDraftBatch: newJurorsPerDraftBatch })
        })
      })

      context('when the given value is greater than zero', () => {
        const newJurorsPerDraftBatch = bn(0)

        it('reverts', async () => {
          await assertRevert(court.setMaxJurorsPerDraftBatch(newJurorsPerDraftBatch, { from }), 'CT_BAD_MAX_DRAFT_BATCH_SIZE')
        })
      })
    })

    context('when the sender is not the governor config', () => {
      const from = someone

      it('reverts', async () => {
        await assertRevert(court.setMaxJurorsPerDraftBatch(bn(0), { from }), 'CTD_SENDER_NOT_CONFIG_GOVERNOR')
      })
    })
  })
})
