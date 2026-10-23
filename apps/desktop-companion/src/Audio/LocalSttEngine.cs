using System;
using System.Collections.Generic;
using System.IO;
using System.Speech.AudioFormat;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

namespace Nexus.DesktopCompanion.Audio
{
    public class TranscriptionResult
    {
        public string Text { get; set; }
        public float Confidence { get; set; }
        public long DurationMs { get; set; }
        public bool IsSuccess { get; set; }
        public string ErrorMessage { get; set; }
        public string GrammarRule { get; set; }
    }

    public class LocalSttEngine : IDisposable
    {
        private readonly SpeechRecognitionEngine _recognizer;
        private readonly object _engineLock = new object();

        // End of Utterance (EOU) Detection State
        private readonly MemoryStream _utteranceBuffer = new MemoryStream();
        private volatile bool _isRecordingUtterance = false;
        private int _consecutiveSilenceFrames = 0;
        private const int SILENCE_FRAMES_THRESHOLD = 5; // ~500ms at 100ms per frame
        private const float VAD_SPEECH_THRESHOLD = 0.300f;

        private volatile bool _isBusy = false;

        public event Action<TranscriptionResult> OnTranscriptionCompleted;
        public event Action OnEndOfUtteranceDetected;

        public bool IsRecordingUtterance { get { return _isRecordingUtterance; } }
        public bool IsBusy { get { return _isBusy; } }

        public LocalSttEngine()
        {
            try
            {
                _recognizer = new SpeechRecognitionEngine();

                // 1. Assistant Command Grammar for common high-accuracy assistant interactions
                Choices assistantPhrases = new Choices(new string[] {
                    "what time is it",
                    "what time is it in Asia/Kolkata",
                    "what time is it in UTC",
                    "calculate twenty five times four",
                    "calculate 100 plus 50",
                    "read the file README",
                    "read the file readme",
                    "read the file readme dot md",
                    "read the file README dot md",
                    "inspect the file README",
                    "inspect the file readme",
                    "inspect the file readme dot md",
                    "inspect the file README dot md",
                    "read the file README.md",
                    "Inspect the file README.md",
                    "search knowledge for data privacy",
                    "create a task to review system logs",
                    "check my schedule for today",
                    "what is the status of Project NEXUS",
                    "hello NEXUS",
                    "good morning",
                    "stop",
                    "cancel",
                    "mute",
                    "mute microphone",
                    "mute mic",
                    "nexus mute",
                    "nexus stop",
                    "nexus pause",
                    "pause",
                    "quiet"
                });

                GrammarBuilder gbCmd = new GrammarBuilder(assistantPhrases);
                Grammar cmdGrammar = new Grammar(gbCmd) { Name = "AssistantCommandGrammar", Priority = 1 };
                _recognizer.LoadGrammar(cmdGrammar);

                // 2. Open-ended Dictation Grammar for general arbitrary natural language
                DictationGrammar dictation = new DictationGrammar { Name = "OpenDictationGrammar" };
                _recognizer.LoadGrammar(dictation);

                Console.WriteLine("[STT] Local Speech-to-Text Engine initialized with dual grammar (Assistant Commands + Dictation).");
            }
            catch (Exception ex)
            {
                Console.WriteLine("[STT] SpeechRecognitionEngine init note: " + ex.Message);
            }
        }

        #region Utterance Framing & End of Utterance (EOU)
        public void StartUtteranceRecording()
        {
            lock (_utteranceBuffer)
            {
                _utteranceBuffer.SetLength(0);
                _isRecordingUtterance = true;
                _consecutiveSilenceFrames = 0;
            }
            Console.WriteLine("[STT] Utterance recording started. Awaiting speech...");
        }

        public void ProcessAudioChunkForEou(byte[] pcmData, float rmsLevel)
        {
            if (!_isRecordingUtterance) return;

            lock (_utteranceBuffer)
            {
                _utteranceBuffer.Write(pcmData, 0, pcmData.Length);

                if (rmsLevel < VAD_SPEECH_THRESHOLD)
                {
                    _consecutiveSilenceFrames++;
                    // If we have recorded at least 0.25s of audio and now have trailing silence, trigger EOU
                    if (_utteranceBuffer.Length >= 8000 && _consecutiveSilenceFrames >= SILENCE_FRAMES_THRESHOLD)
                    {
                        _isRecordingUtterance = false;
                        byte[] finalPcm = _utteranceBuffer.ToArray();

                        ThreadPool.QueueUserWorkItem(_ =>
                        {
                            if (OnEndOfUtteranceDetected != null)
                            {
                                try { OnEndOfUtteranceDetected(); } catch { }
                            }
                            TranscribePcmAsync(finalPcm);
                        });
                    }
                }
                else
                {
                    _consecutiveSilenceFrames = 0;
                }
            }
        }

        public void CancelUtterance()
        {
            lock (_utteranceBuffer)
            {
                _isRecordingUtterance = false;
                _utteranceBuffer.SetLength(0);
                _consecutiveSilenceFrames = 0;
            }
            _isBusy = false;
            Console.WriteLine("[STT] Utterance recording cancelled.");
        }
        #endregion

        #region Transcription Execution
        public TranscriptionResult TranscribePcm(byte[] pcmData, int sampleRate = 16000)
        {
            long t0 = Environment.TickCount;

            // 1. Validation & Malformed Audio Checks
            if (pcmData == null || pcmData.Length == 0)
            {
                return new TranscriptionResult
                {
                    IsSuccess = false,
                    Text = "",
                    Confidence = 0.0f,
                    DurationMs = Environment.TickCount - t0,
                    ErrorMessage = "AUDIO_EMPTY: Audio buffer contains zero bytes."
                };
            }

            if (pcmData.Length % 2 != 0)
            {
                return new TranscriptionResult
                {
                    IsSuccess = false,
                    Text = "",
                    Confidence = 0.0f,
                    DurationMs = Environment.TickCount - t0,
                    ErrorMessage = "AUDIO_MALFORMED: Audio byte count must be an even multiple for 16-bit PCM."
                };
            }

            // Minimum 200ms audio required (16000 * 2 * 0.2 = 6400 bytes)
            if (pcmData.Length < 3200)
            {
                return new TranscriptionResult
                {
                    IsSuccess = false,
                    Text = "",
                    Confidence = 0.0f,
                    DurationMs = Environment.TickCount - t0,
                    ErrorMessage = "AUDIO_TOO_SHORT: Buffer duration under 100ms threshold."
                };
            }

            // Check if audio is completely flat silence
            bool hasSignal = false;
            for (int i = 0; i < pcmData.Length; i += 2)
            {
                short sample = (short)(pcmData[i] | (pcmData[i + 1] << 8));
                if (Math.Abs(sample) > 250)
                {
                    hasSignal = true;
                    break;
                }
            }

            if (!hasSignal)
            {
                return new TranscriptionResult
                {
                    IsSuccess = false,
                    Text = "",
                    Confidence = 0.0f,
                    DurationMs = Environment.TickCount - t0,
                    ErrorMessage = "AUDIO_SILENCE: No vocal energy detected above noise floor."
                };
            }

            _isBusy = true;
            try
            {
                lock (_engineLock)
                {
                    if (_recognizer == null)
                    {
                        return new TranscriptionResult
                        {
                            IsSuccess = false,
                            Text = "",
                            Confidence = 0.0f,
                            DurationMs = Environment.TickCount - t0,
                            ErrorMessage = "ENGINE_UNAVAILABLE: SpeechRecognitionEngine is not initialized."
                        };
                    }

                    using (MemoryStream wavStream = WrapPcmInWavStream(pcmData, sampleRate))
                    {
                        wavStream.Position = 0;
                        _recognizer.SetInputToWaveStream(wavStream);

                        RecognitionResult recResult = _recognizer.Recognize(TimeSpan.FromSeconds(6));
                        long duration = Environment.TickCount - t0;

                        if (recResult != null && !string.IsNullOrEmpty(recResult.Text))
                        {
                            return new TranscriptionResult
                            {
                                IsSuccess = true,
                                Text = recResult.Text,
                                Confidence = recResult.Confidence,
                                DurationMs = duration,
                                GrammarRule = recResult.Grammar != null ? recResult.Grammar.Name : "Unknown"
                            };
                        }
                        else
                        {
                            return new TranscriptionResult
                            {
                                IsSuccess = false,
                                Text = "",
                                Confidence = 0.0f,
                                DurationMs = duration,
                                ErrorMessage = "NO_MATCH: Audio energy was recognized but did not match grammatical vocabulary."
                            };
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                return new TranscriptionResult
                {
                    IsSuccess = false,
                    Text = "",
                    Confidence = 0.0f,
                    DurationMs = Environment.TickCount - t0,
                    ErrorMessage = "ENGINE_ERROR: " + ex.Message
                };
            }
            finally
            {
                _isBusy = false;
            }
        }

        public void TranscribePcmAsync(byte[] pcmData, int sampleRate = 16000)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                TranscriptionResult res = TranscribePcm(pcmData, sampleRate);
                if (OnTranscriptionCompleted != null)
                {
                    try { OnTranscriptionCompleted(res); } catch { }
                }
            });
        }

        private MemoryStream WrapPcmInWavStream(byte[] pcmData, int sampleRate)
        {
            MemoryStream ms = new MemoryStream();
            using (BinaryWriter bw = new BinaryWriter(ms, Encoding.UTF8, true))
            {
                // RIFF header
                bw.Write(Encoding.ASCII.GetBytes("RIFF"));
                bw.Write(36 + pcmData.Length);
                bw.Write(Encoding.ASCII.GetBytes("WAVE"));

                // fmt chunk
                bw.Write(Encoding.ASCII.GetBytes("fmt "));
                bw.Write(16); // SubChunk1Size for PCM
                bw.Write((short)1); // AudioFormat 1 = PCM
                bw.Write((short)1); // NumChannels = 1 (Mono)
                bw.Write(sampleRate);
                bw.Write(sampleRate * 2); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
                bw.Write((short)2); // BlockAlign (NumChannels * BitsPerSample/8)
                bw.Write((short)16); // BitsPerSample

                // data chunk
                bw.Write(Encoding.ASCII.GetBytes("data"));
                bw.Write(pcmData.Length);
                bw.Write(pcmData);
            }
            return ms;
        }
        #endregion

        public void Dispose()
        {
            CancelUtterance();
            if (_recognizer != null)
            {
                try
                {
                    _recognizer.Dispose();
                }
                catch { }
            }
        }
    }
}
