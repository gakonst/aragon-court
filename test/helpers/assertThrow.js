const REVERT_ERROR_CODE = 'revert'
const GANACHE_CLI_ERROR_PREFIX = 'Returned error: '
const GANACHE_CORE_ERROR_PREFIX = 'VM Exception while processing transaction:'

function assertError(error, expectedErrorCode) {
  assert(error.message.search(expectedErrorCode) > -1, `Expected error code "${expectedErrorCode}" but failed with "${error}" instead.`)
}

async function assertThrows(blockOrPromise, expectedErrorCode, expectedReason) {
  try {
    (typeof blockOrPromise === 'function') ? await blockOrPromise() : await blockOrPromise
  } catch (error) {
    assertError(error, expectedErrorCode)
    return error
  }
  // assert.fail() for some reason does not have its error string printed 🤷
  assert(0, `Expected "${expectedErrorCode}"${expectedReason ? ` (with reason: "${expectedReason}")` : ''} but it did not fail`)
}

async function assertRevert(blockOrPromise, reason) {
  const error = await assertThrows(blockOrPromise, REVERT_ERROR_CODE, reason)

  error.reason = error.message
    .replace(GANACHE_CLI_ERROR_PREFIX, '')
    .replace(`${GANACHE_CORE_ERROR_PREFIX} ${REVERT_ERROR_CODE}`, '')
    .replace(` -- Reason given: ${reason}.`, '').trim()
    // Truffle 5 sometimes add an extra ' -- Reason given: reason.' to the error message 🤷

  if (reason) {
    assert.equal(error.reason, reason, `Expected revert reason "${reason}" but failed with "${error.reason || 'no reason'}" instead.`)
  }
}

module.exports = {
  assertRevert,
}
