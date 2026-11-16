import React from '@theia/core/shared/react';

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: any) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function recognitionConstructor(): (new () => Recognition) | undefined {
  const browser = window as any;
  return browser.SpeechRecognition || browser.webkitSpeechRecognition;
}

/** Dictation only inserts final text; sending it remains an explicit user action. */
export function VoiceInput({
  append,
  disabled = false,
  language = 'en-US',
}: {
  append: (text: string) => void;
  disabled?: boolean;
  language?: string;
}) {
  const recognition = React.useRef<Recognition | undefined>(undefined);
  const appendRef = React.useRef(append);
  appendRef.current = append;
  const [listening, setListening] = React.useState(false);
  const [interim, setInterim] = React.useState('');
  const [error, setError] = React.useState('');
  const available = Boolean(recognitionConstructor());

  React.useEffect(() => {
    if (disabled && recognition.current) {
      recognition.current.abort();
      recognition.current = undefined;
      setListening(false);
      setInterim('');
    }
  }, [disabled]);
  React.useEffect(
    () => () => {
      const active = recognition.current;
      if (active) {
        active.onresult = active.onerror = active.onend = null;
        active.abort();
      }
    },
    [],
  );

  const start = () => {
    const Constructor = recognitionConstructor();
    if (!Constructor || recognition.current) return;
    const active = new Constructor();
    recognition.current = active;
    active.lang = language;
    active.continuous = true;
    active.interimResults = true;
    setError('');
    setListening(true);
    active.onresult = (event) => {
      if (recognition.current !== active) return;
      let final = '',
        partial = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) final += result[0].transcript + ' ';
        else partial += result[0].transcript;
      }
      if (final.trim()) appendRef.current(final.trim());
      setInterim(partial);
    };
    active.onerror = (event) => {
      if (recognition.current !== active) return;
      const messages: Record<string, string> = {
        'not-allowed':
          'Microphone permission was denied. Allow it in browser settings, or type instead.',
        'service-not-allowed':
          'Speech recognition is unavailable in this browser. Type instead.',
        'audio-capture':
          'No microphone is available. Check your audio input, or type instead.',
        network:
          'Speech recognition could not reach its service. Check your connection, or type instead.',
        'no-speech':
          'No speech was detected. Try dictation again, or type instead.',
      };
      if (event.error !== 'aborted')
        setError(
          messages[event.error] ||
            `Dictation failed (${event.error}). Type instead.`,
        );
      recognition.current = undefined;
      active.onresult = active.onerror = active.onend = null;
      active.abort();
      setListening(false);
      setInterim('');
    };
    active.onend = () => {
      if (recognition.current !== active) return;
      recognition.current = undefined;
      setListening(false);
      setInterim('');
    };
    try {
      window.speechSynthesis?.cancel();
      active.start();
    } catch (failure) {
      recognition.current = undefined;
      setListening(false);
      setError(`Could not start dictation: ${String(failure)}. Type instead.`);
    }
  };

  return (
    <div className="aiide-dictation">
      <button
        type="button"
        disabled={disabled || !available}
        aria-pressed={listening}
        onClick={() => (listening ? recognition.current?.stop() : start())}
      >
        {listening ? 'Stop dictation' : 'Dictate'}
      </button>
      <p className="aiide-note">
        {available
          ? 'Dictation uses your browser’s speech service, which may send audio to its provider. Review the text before sending.'
          : 'Speech recognition is unavailable in this browser. You can type instead.'}
      </p>
      <span role="status">{listening ? `Listening… ${interim}` : ''}</span>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
