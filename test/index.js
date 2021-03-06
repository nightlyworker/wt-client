/* eslint-disable no-underscore-dangle */
/* eslint-disable no-plusplus */

import { assert } from 'chai';
import QS from 'qs';
import { omit, assign } from 'lodash';
import { withContext, DEBOUNCE_MIN, WT, SEND_COMPLETED } from '../src';

import { debounce, uuid } from '../src/utils';

const LOAD_WAIT = 100;
const BUFFER = 10;

const HREF = 'https://www.test.url/test-path?hello=world&hi=mom';

let loggedEvents = [];

const context = {
  location: {
    hostname: 'www.test.url',
    href: HREF,
  },
  document: {
    referrer: 'test',
  },
  navigator: {
    userAgent: 'test agent',
  },
  Image: class {
    get src() {
      return this._url;
    }
    set src(url) {
      if (url === this._url) {
        return;
      }
      clearTimeout(this._to);
      this._to = setTimeout(() => {
        loggedEvents.push(url);
        const query = url.split('?').pop();
        const parsed = QS.parse(query);
        if (parsed.events.some(e => e.metadata.error)) {
          if (this.onerror) {
            this.onerror();
          }
          return;
        }
        if (this.onload) {
          this.onload();
        }
      }, LOAD_WAIT);
      this._url = url;
    }
  },
};

const wt = withContext(context);

const parseLoggedEvents = () => {
  const parsedEvents = loggedEvents.map(url => QS.parse(url.split('?').pop()));
  const withoutTs = parsedEvents.map(
    parsedEvent => omit({
      ...parsedEvent,
      events: parsedEvent.events.map(p => omit(p, ['ts'])),
    }, ['rts']),
  );
  return withoutTs
    .map(e => e.events.map(event => assign({}, event.metadata, { url: event.url })))
    .reduce((memo, arr) => (Array.isArray(arr) ? [...memo, ...arr] : [...memo, arr]), []);
};

const waitFor = time => new Promise(resolve => setTimeout(resolve, time));

function runEvents(events, cb, timeOffset = 0, wtInstance = wt) {
  setTimeout(() => {
    events.forEach(event => wtInstance('event', event));
    setTimeout(() => {
      cb(parseLoggedEvents());
    }, LOAD_WAIT + DEBOUNCE_MIN + BUFFER + (timeOffset / 2));
  }, (timeOffset / 2));
}

describe('wt-tracker.', () => {
  let initialized = false;

  before(() => {
    initialized = true;
    wt('initialize', {
      trackerUrl: 'pixel.test.url/pixel.gif',
      stringifyOptions: {},
    });
  });

  beforeEach(() => {
    loggedEvents = [];
    if (!initialized) {
      return;
    }
    wt('clear');
  });

  it('should load without error', (done) => {
    wt('test', { hello: 'world' });
    setTimeout(done, LOAD_WAIT + DEBOUNCE_MIN + BUFFER);
  });

  it('should log one call', (done) => {
    const events = [{ hello: 'world', url: HREF }];
    runEvents(events, (result) => {
      assert.deepEqual(events, result);
      done();
    });
  });

  it('should handle after first load events', (done) => {
    const events = [{ hello: 'world', url: HREF }];
    let touchedCount = 0;
    wt('resetFirstLoad');
    wt('afterFirstLoad', () => {
      touchedCount++;
    });
    assert.equal(touchedCount, 0);
    runEvents(events, () => {
      assert.equal(touchedCount, 1);
      wt('afterFirstLoad', () => {
        touchedCount++;
      });
      assert.equal(touchedCount, 2);
      done();
    });
    wt('resetFirstLoad');
    wt('afterFirstLoad', () => {
      touchedCount++;
    });
  });

  it('should hit the event emitter', (done) => {
    const events = [{ hello: 'world', url: HREF }];
    let touched = false;
    const unsub = wt('subscribe', SEND_COMPLETED, () => {
      touched = true;
    });
    runEvents(events, () => {
      assert.equal(touched, true);
      unsub();
      done();
    });
  });

  it('should respect unsub', (done) => {
    const events = [{ hello: 'world', url: HREF }];
    let touched = false;
    const unsub = wt('subscribe', SEND_COMPLETED, () => {
      touched = true;
    });
    unsub();
    runEvents(events, () => {
      assert.equal(touched, false);
      done();
    });
  });

  it('should enqueue calls while networking', () => {
    const events = [{ hello: 'world', url: HREF }];
    events.forEach(event => wt('event', event));
    wt('flush');
    // now loading
    return waitFor(LOAD_WAIT - 1)
      .then(() => {
        events.forEach(event => wt('event', event));
      })
      .then(() => waitFor(1 + LOAD_WAIT + BUFFER + DEBOUNCE_MIN))
      .then(() => {
        const parsedEvents = parseLoggedEvents();
        assert.deepEqual(events.concat(events), parsedEvents);
      });
  });

  it('should update defaults', (done) => {
    const events = [{ hello: 'world', url: HREF }];

    wt('set', { userId: '1' });

    runEvents(events, (result) => {
      assert.deepEqual(events.map(r => Object.assign(r, { userId: '1' })), result);
      done();
    });
  });

  it('should handle errors', (done) => {
    const events = [{ error: true }];

    const inst = wt('instance');

    runEvents(events, () => {
      assert(inst.loading === false);
      done();
    });
  });

  /* eslint-disable no-shadow */

  it('should not double load', (done) => {
    const wt = withContext(context);
    const inst = wt('instance');
    inst.sendToServer = () => waitFor(100);
    const events = [];
    for (let i = 0; i < 1000; i++) {
      events.push({ hello: 'world', url: HREF });
    }
    events.forEach(event => wt('event', event));
    wt('flush');
    setTimeout(() => {
      const eventQueueLength = inst.eventQueue.length;
      inst.processEvents();
      assert.equal(eventQueueLength, inst.eventQueue.length);
      done();
    }, 1);
  });

  it('should process an empty queue', (done) => {
    const wt = withContext(context);
    const inst = wt('instance');
    inst.sendToServer = () => waitFor(1);
    const events = [];
    for (let i = 0; i < 10; i++) {
      events.push({ hello: 'world', url: HREF });
    }
    events.forEach(event => wt('event', event));
    wt('flush');
    setTimeout(() => {
      inst.sendToServer = () => {
        throw new Error('Should not call');
      };
      inst.processEvents();
      setTimeout(() => done(), 100);
    }, 100);
  });

  /* eslint-enable no-shadow */

  it('should update config', () => {
    const config = { hello: 'world', url: HREF };
    wt('config', config);
    const inst = wt('instance');
    assert.equal(inst.wtConfig.hello, config.hello);
  });

  it('should return an instance', () => {
    const inst = wt('instance');
    assert(inst instanceof WT);
  });

  it('should guess root url based on context', () => {
    const inst = wt('instance');
    const currentConfig = inst.wtConfig;
    wt('initialize', {
      trackerDomain: null,
      trackerUrl: null,
    });
    let url = inst.getRoot();
    assert.equal(url, `//${context.location.hostname}`);
    url = inst.getUrl();
    assert.equal(url, `//${context.location.hostname}/track.gif`);
    const trackerDomain = 'test.domain.com';
    wt('initialize', {
      trackerDomain,
    });
    url = inst.getRoot();
    assert.equal(url, trackerDomain);
    wt('initialize', currentConfig);
  });

  it('should update defaults with a function', () => {
    const inst = wt('instance');
    const paramDefaults = { userId: '1' };
    wt('set', () => (paramDefaults));
    assert.deepEqual(paramDefaults, inst.paramDefaults);
  });

  it('should have uuid set for event', () => {
    const inst = wt('instance');
    const currentConfig = inst.wtConfig;
    currentConfig.cookies = true;
    wt('initialize', currentConfig);
    wt('pageview');
    const events = inst.eventQueue;
    assert.match(events[0].page_uuid, /^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/, 'UUIDs must be formatted as a UUID');
    wt('event');
    assert.match(events[1].page_uuid, /^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/, 'UUIDs must be formatted as a UUID');
  });
});

describe('utils.debounce', () => {
  it('debounce should work', (done) => {
    let flipped = false;
    const flipTrue = () => {
      flipped = true;
    };
    const debouncedFlip = debounce(flipTrue, DEBOUNCE_MIN);
    debouncedFlip();
    setTimeout(() => {
      assert(flipped);
      done();
    }, DEBOUNCE_MIN + 1);
  });

  it('debounce flush should work', (done) => {
    let flipped = false;
    const flipTrue = () => {
      flipped = true;
    };
    const debouncedFlip = debounce(flipTrue, DEBOUNCE_MIN);
    debouncedFlip();
    debouncedFlip.flush();
    setTimeout(() => {
      assert(flipped);
      done();
    }, 1);
  });

  it('debounce flush should not work with clear', (done) => {
    let flipped = false;
    const flipTrue = () => {
      flipped = true;
    };
    const debouncedFlip = debounce(flipTrue, DEBOUNCE_MIN);
    debouncedFlip();
    debouncedFlip.clear();
    debouncedFlip.flush();
    setTimeout(() => {
      assert(flipped === false);
      done();
    }, 1);
  });
});

describe('utils.uuid', () => {
  it('matches the uuid format', () => {
    const value = uuid();
    assert.match(value, /^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/, 'UUIDs must be formatted as a UUID');
  });

  it('generates a unique uuid', () => {
    const a = uuid();
    const b = uuid();
    assert(a !== b, 'UUIDs must be unique');
  });
});
