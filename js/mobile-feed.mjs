function uniqueWorks(works) {
  const seen = new Set();
  return (Array.isArray(works) ? works : []).filter((work) => {
    const id = work?.id;
    if (id == null || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function shuffle(works, random) {
  const shuffled = [...works];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [
      shuffled[target],
      shuffled[index],
    ];
  }
  return shuffled;
}

export function buildMobileFeedQueue(works, random = Math.random) {
  const featured = [];
  const remaining = [];

  uniqueWorks(works).forEach((work, index) => {
    if (work.is_featured) featured.push({ work, index });
    else remaining.push(work);
  });

  featured.sort((left, right) => {
    const dateDifference =
      new Date(right.work.created_at).getTime() -
      new Date(left.work.created_at).getTime();
    return Number.isNaN(dateDifference) ? left.index - right.index : dateDifference;
  });

  return [
    ...featured.map(({ work }) => work),
    ...shuffle(remaining, random),
  ];
}

export function resolveHorizontalSwipe(deltaX, deltaY, threshold = 56) {
  if (Math.abs(deltaX) < threshold) return null;
  if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return null;
  return deltaX < 0 ? "next" : "previous";
}

export function createMobileFeedController(works, random = Math.random) {
  let queue = buildMobileFeedQueue(works, random);
  let cursor = 0;

  return {
    current() {
      return queue[cursor] ?? null;
    },
    next() {
      if (cursor >= queue.length - 1) return null;
      cursor += 1;
      return queue[cursor];
    },
    previous() {
      if (cursor > 0) cursor -= 1;
      return queue[cursor] ?? null;
    },
    reset(nextWorks, nextRandom = Math.random) {
      queue = buildMobileFeedQueue(nextWorks, nextRandom);
      cursor = 0;
      return queue[cursor] ?? null;
    },
  };
}
