import { describe, expect, it, vi } from 'vitest';
import {
  type AnswerBlock,
  DEEPSEEK_CONFIG,
  deepseekActions,
  extractDeepSeekFailureText,
  type MessageProbe,
  pickAnswer,
  pickAssistantErrorText,
} from '../src/providers/deepseek.js';

describe('DeepSeek Provider', () => {
  describe('DEEPSEEK_CONFIG', () => {
    it('should have correct provider name', () => {
      expect(DEEPSEEK_CONFIG.name).toBe('deepseek');
    });

    it('should have correct display name', () => {
      expect(DEEPSEEK_CONFIG.displayName).toBe('DeepSeek');
    });

    it('should have correct URL', () => {
      expect(DEEPSEEK_CONFIG.url).toBe('https://chat.deepseek.com');
    });

    it('should point login to the sign-in page', () => {
      expect(DEEPSEEK_CONFIG.loginUrl).toBe('https://chat.deepseek.com/sign_in');
    });

    it('should offer the chat and reasoning models', () => {
      expect(DEEPSEEK_CONFIG.models).toContain('deepseek-chat');
      expect(DEEPSEEK_CONFIG.models).toContain('deepseek-reasoner');
    });

    it('should default to deepseek-chat', () => {
      expect(DEEPSEEK_CONFIG.defaultModel).toBe('deepseek-chat');
    });

    it('should have a 5-minute default timeout', () => {
      expect(DEEPSEEK_CONFIG.defaultTimeoutMs).toBe(5 * 60 * 1000);
    });
  });

  describe('extractDeepSeekFailureText', () => {
    it('detects server-busy failures', () => {
      expect(extractDeepSeekFailureText('Server busy, please try again later.')).toBe(
        'Server busy, please try again later.',
      );
    });

    it('detects rate-limit failures', () => {
      expect(extractDeepSeekFailureText('Too many requests. Try again later.')).toBe(
        'Too many requests. Try again later.',
      );
    });

    it('detects unavailable-service failures', () => {
      expect(extractDeepSeekFailureText('System temporarily unavailable')).toBe(
        'System temporarily unavailable',
      );
    });

    it('detects network failures', () => {
      expect(extractDeepSeekFailureText('Network Error. Please check your network status.')).toBe(
        'Network Error. Please check your network status.',
      );
    });

    it('does not flag normal assistant responses', () => {
      expect(extractDeepSeekFailureText('Here is the answer you asked for.')).toBeNull();
    });

    it('does not flag empty text', () => {
      expect(extractDeepSeekFailureText('   ')).toBeNull();
    });
  });

  describe('pickAnswer', () => {
    it('returns the last answer block', () => {
      const blocks: AnswerBlock[] = [
        { text: 'first', html: '<p>first</p>', insideThinking: false },
        { text: 'second', html: '<p>second</p>', insideThinking: false },
      ];
      expect(pickAnswer(blocks)).toEqual({
        count: 2,
        text: 'second',
        html: '<p>second</p>',
      });
    });

    it('ignores blocks inside the reasoning area', () => {
      const blocks: AnswerBlock[] = [
        { text: 'I should answer Paris', html: '<p>reasoning</p>', insideThinking: true },
        { text: 'Paris', html: '<p>Paris</p>', insideThinking: false },
      ];
      expect(pickAnswer(blocks)).toEqual({
        count: 1,
        text: 'Paris',
        html: '<p>Paris</p>',
      });
    });

    it('returns an empty snapshot without answers', () => {
      expect(pickAnswer([])).toEqual({ count: 0, text: '', html: '' });
    });
  });

  describe('pickAssistantErrorText', () => {
    const userMessage: MessageProbe = {
      hasUserMarker: true,
      hasAnswer: false,
      errorText: 'Ответь одним словом: столица Франции?',
    };

    it('returns the error slot of the newest assistant message', () => {
      const messages: MessageProbe[] = [
        { hasUserMarker: false, hasAnswer: true, errorText: '' },
        userMessage,
        {
          hasUserMarker: false,
          hasAnswer: true,
          errorText: 'Service error, please try again later.',
        },
      ];
      expect(pickAssistantErrorText(messages)).toBe('Service error, please try again later.');
    });

    it('finds an assistant message that has no answer block', () => {
      const messages: MessageProbe[] = [
        { hasUserMarker: false, hasAnswer: true, errorText: '' },
        {
          hasUserMarker: false,
          hasAnswer: false,
          errorText: 'Server busy, please try again later.',
        },
      ];
      expect(pickAssistantErrorText(messages)).toBe('Server busy, please try again later.');
    });

    it('skips the user message', () => {
      const messages: MessageProbe[] = [
        { hasUserMarker: false, hasAnswer: true, errorText: '' },
        userMessage,
      ];
      expect(pickAssistantErrorText(messages)).toBe('');
    });

    it('returns an empty string without messages', () => {
      expect(pickAssistantErrorText([])).toBe('');
    });
  });

  describe('deepseekActions', () => {
    it('should export all required action methods', () => {
      expect(deepseekActions.isLoggedIn).toBeTypeOf('function');
      expect(deepseekActions.submitPrompt).toBeTypeOf('function');
      expect(deepseekActions.captureResponse).toBeTypeOf('function');
    });

    it('should export optional selectModel method', () => {
      expect(deepseekActions.selectModel).toBeTypeOf('function');
    });
  });
});

// ── Playwright behaviour ─────────────────────────────────────────

interface MockWorld {
  /** Rendered answer blocks. */
  blocks: AnswerBlock[];
  /** Chat messages rendered by the app. */
  messages: MessageProbe[];
  /** Text of the app's toast containers. */
  toastText: string;
  /** DeepThink toggle state. */
  toggle: { visible: boolean; states: string[]; readFails: boolean };
}

function createDeepSeekPage(world: MockWorld) {
  const calls: string[] = [];

  const composer = {
    waitFor: vi.fn(async () => {
      calls.push('composer:waitFor');
    }),
    click: vi.fn(async () => {
      calls.push('composer:click');
    }),
    fill: vi.fn(async () => {
      calls.push('composer:fill');
    }),
    evaluate: vi.fn(async () => false),
    isVisible: vi.fn(async () => true),
  };

  const toggle = {
    isVisible: vi.fn(async () => world.toggle.visible),
    evaluate: vi.fn(async () => {
      calls.push('toggle:evaluate');
      if (world.toggle.readFails) throw new Error('state unavailable');
      const states = world.toggle.states;
      return states.length > 1 ? states.shift() : states[0];
    }),
    click: vi.fn(async () => {
      calls.push('toggle:click');
    }),
  };

  const locator = vi.fn((selector: string) => {
    if (selector.includes('toggle-button')) return { first: () => toggle };
    if (selector.includes('textarea')) return { first: () => composer };
    throw new Error(`Unexpected selector: ${selector}`);
  });

  const evaluate = vi.fn(async (_fn: unknown, arg?: Record<string, string>) => {
    if (!arg) return undefined;
    if ('messageSelector' in arg) {
      calls.push('evaluate:turn');
      return {
        messages: world.messages.map((message) => ({ ...message })),
        toastText: world.toastText,
      };
    }
    if ('answerSelector' in arg) {
      calls.push('evaluate:answers');
      return world.blocks.map((block) => ({ ...block }));
    }
    return undefined;
  });

  const page = {
    locator,
    evaluate,
    keyboard: {
      press: vi.fn(async (key: string) => {
        calls.push(`press:${key}`);
      }),
      type: vi.fn(async () => {}),
    },
    waitForTimeout: vi.fn(async () => {
      calls.push('wait');
    }),
    waitForLoadState: vi.fn(async () => {}),
    url: vi.fn(() => 'https://chat.deepseek.com/'),
  };

  return { page, calls, composer, toggle };
}

function createWorld(overrides: Partial<MockWorld> = {}): MockWorld {
  return {
    blocks: [],
    messages: [],
    toastText: '',
    toggle: { visible: true, states: ['off'], readFails: false },
    ...overrides,
  };
}

describe('DeepSeek selectModel', () => {
  it('rejects an unknown model name', async () => {
    const { page } = createDeepSeekPage(createWorld());

    await expect(deepseekActions.selectModel?.(page as never, 'deepseek-ultra')).rejects.toThrow(
      /Unknown DeepSeek model "deepseek-ultra"/,
    );
  });

  it('fails when the DeepThink toggle is missing', async () => {
    const { page } = createDeepSeekPage(
      createWorld({ toggle: { visible: false, states: ['off'], readFails: false } }),
    );

    await expect(deepseekActions.selectModel?.(page as never, 'deepseek-chat')).rejects.toThrow(
      /DeepThink toggle not found/,
    );
  });

  it('fails when the toggle state cannot be read', async () => {
    const { page } = createDeepSeekPage(
      createWorld({ toggle: { visible: true, states: ['off'], readFails: true } }),
    );

    await expect(deepseekActions.selectModel?.(page as never, 'deepseek-chat')).rejects.toThrow(
      /Cannot read the DeepThink toggle state/,
    );
  });

  it('enables DeepThink for deepseek-reasoner', async () => {
    const { page, toggle } = createDeepSeekPage(
      createWorld({ toggle: { visible: true, states: ['off', 'on'], readFails: false } }),
    );

    await deepseekActions.selectModel?.(page as never, 'deepseek-reasoner');

    expect(toggle.click).toHaveBeenCalledTimes(1);
  });

  it('disables DeepThink for deepseek-chat', async () => {
    const { page, toggle } = createDeepSeekPage(
      createWorld({ toggle: { visible: true, states: ['on', 'off'], readFails: false } }),
    );

    await deepseekActions.selectModel?.(page as never, 'deepseek-chat');

    expect(toggle.click).toHaveBeenCalledTimes(1);
  });

  it('does not click when the toggle already matches the model', async () => {
    const { page, toggle } = createDeepSeekPage(
      createWorld({ toggle: { visible: true, states: ['on'], readFails: false } }),
    );

    await deepseekActions.selectModel?.(page as never, 'deepseek-reasoner');

    expect(toggle.click).not.toHaveBeenCalled();
  });

  it('fails when the toggle does not reach the wanted state', async () => {
    const { page } = createDeepSeekPage(
      createWorld({ toggle: { visible: true, states: ['off', 'off'], readFails: false } }),
    );

    await expect(deepseekActions.selectModel?.(page as never, 'deepseek-reasoner')).rejects.toThrow(
      /Failed to enable DeepThink/,
    );
  });
});

describe('DeepSeek submitPrompt', () => {
  it('fills the composer and submits with Enter', async () => {
    const { page, composer } = createDeepSeekPage(createWorld());

    await deepseekActions.submitPrompt(page as never, 'Сколько будет 2+2?');

    expect(composer.fill).toHaveBeenCalledWith('Сколько будет 2+2?');
    expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
  });

  it('captures the answer baseline before sending the prompt', async () => {
    const { page, calls } = createDeepSeekPage(createWorld());

    await deepseekActions.submitPrompt(page as never, 'Привет');

    const baselineAt = calls.indexOf('evaluate:answers');
    const sentAt = calls.indexOf('press:Enter');
    expect(baselineAt).toBeGreaterThanOrEqual(0);
    expect(sentAt).toBeGreaterThan(baselineAt);
  });
});

describe('DeepSeek captureResponse', () => {
  it('captures the new answer and ignores the reasoning block', async () => {
    const world = createWorld();
    const { page } = createDeepSeekPage(world);

    await deepseekActions.submitPrompt(page as never, '2+2?');
    world.blocks = [
      { text: 'Сначала подумаю', html: '<p>reasoning</p>', insideThinking: true },
      { text: 'Четыре', html: '<p>Четыре</p>', insideThinking: false },
    ];

    const result = await deepseekActions.captureResponse(page as never, { timeoutMs: 1_000 });

    expect(result.text).toBe('Четыре');
    expect(result.markdown).toBe('<p>Четыре</p>');
  });

  it('ignores a service error left in the chat history', async () => {
    const world = createWorld({
      messages: [
        {
          hasUserMarker: false,
          hasAnswer: false,
          errorText: 'Server busy, please try again later.',
        },
      ],
    });
    const { page } = createDeepSeekPage(world);

    await deepseekActions.submitPrompt(page as never, 'Привет');
    // The new turn renders a normal answer, the old error stays in the history.
    world.messages = [
      { hasUserMarker: false, hasAnswer: false, errorText: 'Server busy, please try again later.' },
      { hasUserMarker: true, hasAnswer: false, errorText: 'Привет' },
      { hasUserMarker: false, hasAnswer: true, errorText: '' },
    ];
    world.blocks = [{ text: 'Привет', html: '<p>Привет</p>', insideThinking: false }];

    const result = await deepseekActions.captureResponse(page as never, { timeoutMs: 1_000 });
    expect(result.text).toBe('Привет');
  });

  it('fails on a service error of the current turn', async () => {
    const world = createWorld();
    const { page } = createDeepSeekPage(world);

    await deepseekActions.submitPrompt(page as never, 'Привет');
    world.messages = [
      { hasUserMarker: true, hasAnswer: false, errorText: 'Привет' },
      { hasUserMarker: false, hasAnswer: true, errorText: 'Server busy, please try again later.' },
    ];

    await expect(
      deepseekActions.captureResponse(page as never, { timeoutMs: 1_000 }),
    ).rejects.toThrow(/Server busy, please try again later\./);
  });

  it('fails on an assistant message with an error but no answer block', async () => {
    const world = createWorld();
    const { page } = createDeepSeekPage(world);

    await deepseekActions.submitPrompt(page as never, 'Привет');
    // The app renders the service error in its own message, without an answer.
    world.messages = [
      { hasUserMarker: true, hasAnswer: false, errorText: 'Привет' },
      { hasUserMarker: false, hasAnswer: false, errorText: 'Server busy, please try again later.' },
    ];

    await expect(
      deepseekActions.captureResponse(page as never, { timeoutMs: 1_000 }),
    ).rejects.toThrow(/Server busy, please try again later\./);
  });

  it('fails on a toast error of the current turn', async () => {
    const world = createWorld();
    const { page } = createDeepSeekPage(world);

    await deepseekActions.submitPrompt(page as never, 'Привет');
    world.toastText = 'Too many requests. Try again later.';

    await expect(
      deepseekActions.captureResponse(page as never, { timeoutMs: 1_000 }),
    ).rejects.toThrow(/Too many requests/);
  });

  it('fails when the provider returns no answer', async () => {
    const world = createWorld();
    const { page } = createDeepSeekPage(world);

    await deepseekActions.submitPrompt(page as never, 'Привет');

    await expect(deepseekActions.captureResponse(page as never, { timeoutMs: 50 })).rejects.toThrow(
      /DeepSeek returned no response\./,
    );
  });
});
