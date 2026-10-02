// The palette and visible controls dispatch through the same app commands.
export const EDITOR_COMMANDS = Object.freeze([
  ['new', 'New file'], ['save', 'Save all'], ['find', 'Find / replace'],
  ['search', 'Search project contents'], ['ask', 'Ask AI about this project'],
  ['read', 'Read file'], ['review', 'Review changes'], ['format-json', 'Format JSON'],
  ['edit-anvil', 'Edit selection in Anvil'], ['cancel-anvil', 'Cancel Anvil request'], ['review-anvil', 'Review Anvil proposal'],
  ['apply-anvil', 'Apply reviewed Anvil proposal'], ['revert-anvil', 'Revert applied Anvil proposal'], ['discard-anvil', 'Discard Anvil proposal'],
].map(([id, label]) => Object.freeze({ id, label })));
