const { bn } = require('../helpers/numbers')
const { buildHelper } = require('../helpers/controller')(web3, artifacts)
const { assertRevert } = require('../helpers/assertThrow')
const { SALT, OUTCOMES, encryptVote } = require('../helpers/crvoting')
const { assertEvent, assertAmountOfEvents } = require('../helpers/assertEvent')

const CRVoting = artifacts.require('CRVoting')
const Court = artifacts.require('CourtMockForVoting')

const ERROR_OWNER_MOCK_COMMIT_CHECK_REVERTED = 'CRV_OWNER_MOCK_COMMIT_CHECK_REVERTED'

contract('CRVoting leak', ([_, voter, someone]) => {
  let controller, voting, court

  const POSSIBLE_OUTCOMES = 2

  beforeEach('create base contracts', async () => {
    controller = await buildHelper().deploy()

    voting = await CRVoting.new(controller.address)
    await controller.setVoting(voting.address)

    court = await Court.new(controller.address)
    await controller.setCourt(court.address)
  })

  describe('leak', () => {
    context('when the given vote ID is valid', () => {
      const voteId = 0

      beforeEach('create voting', async () => {
        await court.create(voteId, POSSIBLE_OUTCOMES)
      })

      context('when the given voter has not voted before', () => {
        it('reverts', async () => {
          await assertRevert(voting.leak(voteId, voter, OUTCOMES.LOW, SALT, { from: someone }), 'CRV_INVALID_COMMITMENT_SALT')
        })
      })

      context('when the given voter has already voted', () => {
        const itHandlesLeakedVotesFor = committedOutcome => {
          const commitment = encryptVote(committedOutcome)

          beforeEach('commit a vote', async () => {
            await court.mockVoterWeight(voter, 10)
            await voting.commit(voteId, commitment, { from: voter })
          })

          context('when the owner does not revert when checking the weight of the voter', () => {
            context('when the owner tells a weight greater than zero', () => {
              const weight = 10

              beforeEach('mock voter weight', async () => {
                await court.mockVoterWeight(voter, weight)
              })

              context('when the given outcome matches the one committed by the voter', () => {
                const outcome = committedOutcome

                context('when the given salt matches the one used by the voter', () => {
                  const salt = SALT

                  it('leaks the given vote', async () => {
                    await voting.leak(voteId, voter, outcome, salt, { from: someone })

                    const voterOutcome = await voting.getVoterOutcome(voteId, voter)
                    assert.equal(voterOutcome.toString(), OUTCOMES.LEAKED, 'voter outcome should be leaked')
                  })

                  it('emits an event', async () => {
                    const receipt = await voting.leak(voteId, voter, outcome, salt, { from: someone })

                    assertAmountOfEvents(receipt, 'VoteLeaked')
                    assertEvent(receipt, 'VoteLeaked', { voteId, voter, outcome, leaker: someone })
                  })

                  it('does not affect the outcomes tally', async () => {
                    const previousTally = await voting.getOutcomeTally(voteId, outcome)

                    await voting.leak(voteId, voter, outcome, salt, { from: someone })

                    const currentTally = await voting.getOutcomeTally(voteId, outcome)
                    assert.equal(previousTally.toString(), currentTally.toString(), 'tallies do not match')
                  })

                  it('does not affect the winning outcome', async () => {
                    const previousWinningOutcome = await voting.getWinningOutcome(voteId)
                    const previousWinningOutcomeTally = await voting.getOutcomeTally(voteId, previousWinningOutcome)

                    await voting.leak(voteId, voter, outcome, salt, { from: someone })

                    const currentWinningOutcome = await voting.getWinningOutcome(voteId)
                    assert.equal(previousWinningOutcome.toString(), currentWinningOutcome.toString(), 'winning outcomes do not match')

                    const currentWinningOutcomeTally = await voting.getOutcomeTally(voteId, currentWinningOutcome)
                    assert.equal(previousWinningOutcomeTally.toString(), currentWinningOutcomeTally.toString(), 'winning outcome tallies do not match')
                  })

                  it('does not consider the voter a winner', async () => {
                    await voting.leak(voteId, voter, outcome, salt, { from: someone })

                    const winningOutcome = await voting.getWinningOutcome(voteId)
                    assert.isFalse(await voting.hasVotedInFavorOf(voteId, winningOutcome, voter), 'voter should not be a winner')
                  })
                })

                context('when the given salt does not match the one used by the voter', () => {
                  const salt = '0x'

                  it('reverts', async () => {
                    await assertRevert(voting.leak(voteId, voter, outcome, salt, { from: someone }), 'CRV_INVALID_COMMITMENT_SALT')
                  })
                })
              })

              context('when the given outcome does not match the one committed by the voter', () => {
                const outcome = committedOutcome + 1

                context('when the given salt matches the one used by the voter', () => {
                  const salt = SALT

                  it('reverts', async () => {
                    await assertRevert(voting.leak(voteId, voter, outcome, salt, { from: someone }), 'CRV_INVALID_COMMITMENT_SALT')
                  })
                })

                context('when the given salt does not match the one used by the voter', () => {
                  const salt = '0x'

                  it('reverts', async () => {
                    await assertRevert(voting.leak(voteId, voter, outcome, salt, { from: someone }), 'CRV_INVALID_COMMITMENT_SALT')
                  })
                })
              })
            })
          })

          context('when the owner reverts when checking the weight of the voter', () => {
            beforeEach('mock the owner to revert', async () => {
              await court.mockChecksFailing(true)
            })

            it('reverts', async () => {
              await assertRevert(voting.leak(voteId, voter, committedOutcome, SALT, { from: someone }), ERROR_OWNER_MOCK_COMMIT_CHECK_REVERTED)
            })
          })
        }

        context('when the given voter committed a missing outcome', async () => {
          itHandlesLeakedVotesFor(OUTCOMES.MISSING)
        })

        context('when the given voter committed a leaked outcome', async () => {
          itHandlesLeakedVotesFor(OUTCOMES.LEAKED)
        })

        context('when the given voter committed a refused outcome', async () => {
          itHandlesLeakedVotesFor(OUTCOMES.REFUSED)
        })

        context('when the given voter committed a valid outcome', async () => {
          itHandlesLeakedVotesFor(OUTCOMES.LOW)
        })

        context('when the given voter committed an out-of-bounds outcome', async () => {
          itHandlesLeakedVotesFor(OUTCOMES.HIGH.add(bn(1)))
        })
      })
    })

    context('when the given vote ID is not valid', () => {
      it('reverts', async () => {
        await assertRevert(voting.leak(0, voter, 0, '0x', { from: someone }), 'CRV_VOTE_DOES_NOT_EXIST')
      })
    })
  })
})
