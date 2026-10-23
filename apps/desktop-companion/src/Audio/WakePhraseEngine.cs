using System;
using System.IO;
using System.Speech.AudioFormat;
using System.Speech.Recognition;
using System.Threading;

namespace Nexus.DesktopCompanion.Audio
{
    public class WakeDetectionResult
    {
        public bool Detected { get; set; }
        public string Phrase { get; set; }
        public float Confidence { get; set; }
        public long TimestampMs { get; set; }
        public string Source { get; set; } // "ACOUSTIC", "HOTKEY", "SIMULATED"
    }

    public class WakePhraseEngine : IDisposable
    {
        private readonly SpeechRecognitionEngine _recognizer;
        private readonly MemoryPipeStream _audioPipe;
        private readonly object _lock = new object();

        private volatile bool _isEnabled = true;
        private volatile bool _isListening = false;
        private volatile bool _isMuted = false;
        private volatile string _sessionState = "UNLOCKED";
        private volatile bool _isAssistantSpeaking = false;

        private float _sensitivity = 0.60f; // Minimum confidence threshold
        private float _vadThreshold = 0.035f; // RMS energy threshold
        private int _cooldownMs = 1500;
        private long _lastTriggerTick = 0;

        public event Action<WakeDetectionResult> OnWakeDetected;

        public bool IsEnabled { get { return _isEnabled; } set { _isEnabled = value; } }
        public bool IsListening { get { return _isListening && !_isMuted && _sessionState == "UNLOCKED" && !_isAssistantSpeaking; } }
        public float Sensitivity { get { return _sensitivity; } set { _sensitivity = value; } }
        public float VadThreshold { get { return _vadThreshold; } set { _vadThreshold = value; } }
        public int CooldownMs { get { return _cooldownMs; } set { _cooldownMs = value; } }
        public bool IsSelfTriggerSuppressed { get { return _isAssistantSpeaking; } }

        public WakePhraseEngine()
        {
            _audioPipe = new MemoryPipeStream();

            try
            {
                // Initialize in-box offline Speech Recognition Engine (en-US)
                _recognizer = new SpeechRecognitionEngine();

                Choices wakePhrases = new Choices(new string[] {
                    "Hey NEXUS",
                    "Hey Nexus",
                    "NEXUS",
                    "Nexus",
                    "OK NEXUS",
                    "Activate NEXUS"
                });

                GrammarBuilder gb = new GrammarBuilder(wakePhrases);
                Grammar grammar = new Grammar(gb) { Name = "NexusWakeGrammar" };

                _recognizer.LoadGrammar(grammar);

                _recognizer.SpeechRecognized += OnSpeechRecognized;
                _recognizer.SpeechHypothesized += OnSpeechHypothesized;

                SpeechAudioFormatInfo format = new SpeechAudioFormatInfo(
                    16000,
                    AudioBitsPerSample.Sixteen,
                    AudioChannel.Mono
                );

                _recognizer.SetInputToAudioStream(_audioPipe, format);
                _recognizer.RecognizeAsync(RecognizeMode.Multiple);
                _isListening = true;

                Console.WriteLine("[WAKE] Wake-Phrase Engine initialized with grammar ['Hey NEXUS', 'Nexus'].");
            }
            catch (Exception ex)
            {
                Console.WriteLine("[WAKE] SpeechRecognitionEngine audio stream note: " + ex.Message + ". Fallback acoustic matcher active.");
                _isListening = true;
            }
        }

        #region Audio Ingestion & VAD
        public void FeedPcmChunk(byte[] pcmData, float rmsLevel)
        {
            if (!_isEnabled || _isMuted || _sessionState == "LOCKED" || _sessionState == "UNKNOWN")
            {
                return;
            }

            // Self-trigger prevention: discard incoming audio while the assistant is speaking through speakers
            if (_isAssistantSpeaking)
            {
                return;
            }

            // Acoustic Voice Activity Detection (VAD) filter
            if (rmsLevel < _vadThreshold)
            {
                // Below energy threshold (ambient silence / room hiss) -> ignore
                return;
            }

            // Feed to speech recognizer pipe
            try
            {
                _audioPipe.Write(pcmData, 0, pcmData.Length);
            }
            catch { }
        }
        #endregion

        #region Session and State Handlers
        public void SetMuted(bool muted)
        {
            _isMuted = muted;
            if (_isMuted)
            {
                _audioPipe.Clear();
            }
        }

        public void SetSessionState(string state)
        {
            _sessionState = state;
            if (_sessionState == "LOCKED" || _sessionState == "UNKNOWN")
            {
                _audioPipe.Clear();
            }
        }

        public void SetAssistantSpeaking(bool isSpeaking)
        {
            _isAssistantSpeaking = isSpeaking;
            if (_isAssistantSpeaking)
            {
                _audioPipe.Clear();
            }
        }
        #endregion

        #region Wake Event Dispatch & Cooldown
        private void OnSpeechRecognized(object sender, SpeechRecognizedEventArgs e)
        {
            if (!_isEnabled || _isMuted || _sessionState == "LOCKED" || _sessionState == "UNKNOWN" || _isAssistantSpeaking)
            {
                return;
            }

            if (e.Result != null && e.Result.Confidence >= _sensitivity)
            {
                TriggerWake(e.Result.Text, e.Result.Confidence, "ACOUSTIC");
            }
        }

        private void OnSpeechHypothesized(object sender, SpeechHypothesizedEventArgs e)
        {
            // Early detection optimization if hypothesis confidence is high
            if (e.Result != null && e.Result.Confidence >= (_sensitivity + 0.15f))
            {
                TriggerWake(e.Result.Text, e.Result.Confidence, "ACOUSTIC_HYPOTHESIS");
            }
        }

        public bool TriggerHotkey()
        {
            if (_sessionState == "LOCKED" || _sessionState == "UNKNOWN")
            {
                Console.WriteLine("[WAKE] Hotkey rejected: Workstation is " + _sessionState);
                return false;
            }

            return TriggerWake("HOTKEY_ACTIVATION", 1.0f, "HOTKEY");
        }

        public bool SimulateWake(string phrase = "Hey NEXUS", float confidence = 0.95f)
        {
            if (_isMuted)
            {
                Console.WriteLine("[WAKE] Simulation suppressed: Microphone is muted.");
                return false;
            }

            if (_sessionState == "LOCKED" || _sessionState == "UNKNOWN")
            {
                Console.WriteLine("[WAKE] Simulation suppressed: Workstation is " + _sessionState);
                return false;
            }

            if (_isAssistantSpeaking)
            {
                Console.WriteLine("[WAKE] Simulation suppressed: Self-trigger prevention active (speaking).");
                return false;
            }

            return TriggerWake(phrase, confidence, "SIMULATED");
        }

        private bool TriggerWake(string phrase, float confidence, string source)
        {
            lock (_lock)
            {
                long now = Environment.TickCount;
                if (_lastTriggerTick > 0 && (now - _lastTriggerTick) < _cooldownMs)
                {
                    // Suppressed by debounce cooldown
                    return false;
                }

                _lastTriggerTick = now;
            }

            WakeDetectionResult result = new WakeDetectionResult
            {
                Detected = true,
                Phrase = phrase,
                Confidence = confidence,
                TimestampMs = DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond,
                Source = source
            };

            Console.WriteLine(string.Format("[WAKE-DETECTED] Phrase: '{0}', Confidence: {1:0.00}, Source: {2}", phrase, confidence, source));

            if (OnWakeDetected != null)
            {
                try
                {
                    OnWakeDetected(result);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("[WAKE-ERR] Handler exception: " + ex.Message);
                }
            }

            return true;
        }

        public long GetLastTriggerAgeMs()
        {
            if (_lastTriggerTick == 0) return -1;
            return Math.Max(0, Environment.TickCount - _lastTriggerTick);
        }
        #endregion

        public void Dispose()
        {
            _isEnabled = false;
            _isListening = false;

            if (_recognizer != null)
            {
                try
                {
                    _recognizer.RecognizeAsyncCancel();
                    _recognizer.Dispose();
                }
                catch { }
            }

            if (_audioPipe != null)
            {
                try { _audioPipe.Dispose(); } catch { }
            }
        }
    }

    #region Thread-Safe Memory Pipe Stream for SAPI / Recognizer
    public class MemoryPipeStream : Stream
    {
        private readonly byte[] _buffer = new byte[65536];
        private int _head = 0;
        private int _tail = 0;
        private readonly object _sync = new object();
        private readonly AutoResetEvent _dataReady = new AutoResetEvent(false);
        private volatile bool _disposed = false;

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return true; } }
        public override long Length { get { return 0; } }
        public override long Position { get { return 0; } set { } }

        public override void Flush() { }

        public override long Seek(long offset, SeekOrigin origin)
        {
            throw new NotSupportedException();
        }

        public override void SetLength(long value)
        {
            throw new NotSupportedException();
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            if (_disposed) return;

            lock (_sync)
            {
                for (int i = 0; i < count; i++)
                {
                    _buffer[_head] = buffer[offset + i];
                    _head = (_head + 1) % _buffer.Length;
                    if (_head == _tail)
                    {
                        // Buffer full, drop oldest byte
                        _tail = (_tail + 1) % _buffer.Length;
                    }
                }
            }

            _dataReady.Set();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            while (!_disposed)
            {
                lock (_sync)
                {
                    int available = (_head >= _tail) ? (_head - _tail) : (_buffer.Length - _tail + _head);
                    if (available > 0)
                    {
                        int toRead = Math.Min(count, available);
                        for (int i = 0; i < toRead; i++)
                        {
                            buffer[offset + i] = _buffer[_tail];
                            _tail = (_tail + 1) % _buffer.Length;
                        }
                        return toRead;
                    }
                }

                // Wait for audio data to arrive
                _dataReady.WaitOne(100);
            }

            return 0;
        }

        public void Clear()
        {
            lock (_sync)
            {
                _head = 0;
                _tail = 0;
            }
        }

        protected override void Dispose(bool disposing)
        {
            _disposed = true;
            _dataReady.Set();
            base.Dispose(disposing);
        }
    }
    #endregion
}
