// One build at a time. Requests during a build merge into a single follow-up build, and each result names the source
// revision it was made from, so the page never treats an old PDF as current.
export function createBuilder({ compile, onState = () => {} }) {
  let running = false, again = false, latest = 0;

  async function run() {
    running = true;
    do {
      again = false;
      const revision = latest;
      onState({ phase:'building', revision });
      try {
        onState({ phase:'done', revision, result:await compile(revision), stale:revision !== latest });
      } catch (error) {
        onState({ phase:'failed', revision, error });
      }
    } while (again);
    running = false;
  }

  return {
    request(revision) {
      latest = revision;
      if (running) { again = true; return; }
      run();
    },
    get running() { return running; },
  };
}
