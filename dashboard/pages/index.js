import { useState, useEffect } from 'react';

// Main dashboard page with state visualization and query playground
// (global styles are imported in pages/_app.js)
export default function Home() {
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [systemState, setSystemState] = useState([]);

  // Fetch system state on mount (optional endpoint)
  useEffect(() => {
    async function fetchState() {
      try {
        const res = await fetch('/api/state');
        if (res.ok) {
          const data = await res.json();
          setSystemState(data.items || []);
        }
      } catch (e) {
        // Skip if endpoint doesn't exist yet
        console.log('State endpoint not available');
      }
    }
    fetchState();
  }, []);

  const getConfidenceBadgeStyle = (tier) => {
    switch (tier) {
      case 'VERIFIED':
        return { backgroundColor: '#22c55e', color: 'white' };
      case 'PARTIAL':
        return { backgroundColor: '#f97316', color: 'white' };
      case 'UNGROUNDED':
      default:
        return { backgroundColor: '#ef4444', color: 'white' };
    }
  };

  const handleAsk = async () => {
    if (!query.trim()) return;

    setLoading(true);
    setResponse(null);

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': 'framework-13',
        },
        body: JSON.stringify({ query }),
      });

      if (res.ok) {
        const data = await res.json();
        setResponse(data);
      } else {
        setResponse({ error: 'Failed to get response' });
      }
    } catch (e) {
      setResponse({ error: e.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={styles.main}>
      <h1 style={styles.title}>System Grounding Dashboard</h1>
      <p style={styles.subtitle}>Query your verified local system state</p>

      {/* System State Overview */}
      {systemState.length > 0 && (
        <section style={styles.stateSection}>
          <h2 style={styles.sectionTitle}>System State Overview</h2>
          <div style={styles.stateGrid}>
            {systemState.map((item, idx) => (
              <div key={idx} style={styles.stateCard}>
                <strong>{item.recordType}</strong>
                <span style={styles.stateId}>{item.id}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Query Input */}
      <section style={styles.querySection}>
        <textarea
          style={styles.textarea}
          placeholder="Ask about your system... (e.g., 'What packages are installed?', 'Show me GPU drivers')"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={4}
        />
        <button
          style={{ ...styles.button, opacity: loading ? 0.7 : 1 }}
          onClick={handleAsk}
          disabled={loading}
        >
          {loading ? 'Processing...' : 'Ask Grounded AI'}
        </button>
      </section>

      {/* Response Display */}
      {response && (
        <section style={styles.responseSection}>
          {response.error ? (
            <div style={styles.errorBox}>
              <strong>Error:</strong> {response.error}
            </div>
          ) : (
            <>
              {/* Confidence Badge */}
              <div style={styles.confidenceRow}>
                <span style={styles.confidenceLabel}>Confidence:</span>
                <span
                  style={{
                    ...styles.badge,
                    ...getConfidenceBadgeStyle(response.confidenceTier),
                  }}
                >
                  {response.confidenceTier} ({Math.round(response.confidenceScore * 100)}%)
                </span>
              </div>

              {/* Answer */}
              <div style={styles.answerBox}>
                <pre style={styles.answerText}>{response.answer}</pre>
              </div>

              {/* Context Details */}
              <details style={styles.details}>
                <summary style={styles.summary}>View Context (grounding details)</summary>
                <div style={styles.contextContainer}>
                  <h4>Context Provided:</h4>
                  <pre style={styles.contextPre}>{response.contextProvided}</pre>

                  {response.staleRecords && response.staleRecords.length > 0 && (
                    <div style={styles.staleSection}>
                      <h4>Stale Records:</h4>
                      <ul>
                        {response.staleRecords.map((sk, idx) => (
                          <li key={idx} style={styles.staleItem}>{sk}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {response.missingData && response.missingData.length > 0 && (
                    <div style={styles.missingSection}>
                      <h4>Missing Data:</h4>
                      <ul>
                        {response.missingData.map((item, idx) => (
                          <li key={idx} style={styles.missingItem}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </details>
            </>
          )}
        </section>
      )}
    </main>
  );
}

const styles = {
  main: {
    maxWidth: '800px',
    margin: '0 auto',
    padding: '20px',
  },
  title: {
    fontSize: '2rem',
    marginBottom: '8px',
    color: '#1a1a1a',
  },
  subtitle: {
    color: '#666',
    marginBottom: '30px',
  },
  stateSection: {
    marginBottom: '30px',
  },
  sectionTitle: {
    fontSize: '1.2rem',
    marginBottom: '12px',
    color: '#333',
  },
  stateGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: '10px',
  },
  stateCard: {
    backgroundColor: 'white',
    padding: '12px',
    borderRadius: '8px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    display: 'flex',
    flexDirection: 'column',
  },
  stateId: {
    fontSize: '0.85rem',
    color: '#666',
    marginTop: '4px',
    wordBreak: 'break-all',
  },
  querySection: {
    marginBottom: '30px',
  },
  textarea: {
    width: '100%',
    padding: '12px',
    fontSize: '1rem',
    border: '1px solid #ddd',
    borderRadius: '8px',
    resize: 'vertical',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  button: {
    marginTop: '12px',
    padding: '12px 24px',
    fontSize: '1rem',
    backgroundColor: '#2563eb',
    color: 'white',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontWeight: '600',
  },
  responseSection: {
    backgroundColor: 'white',
    padding: '20px',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
  },
  errorBox: {
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    color: '#dc2626',
    padding: '12px',
    borderRadius: '6px',
  },
  confidenceRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '16px',
  },
  confidenceLabel: {
    fontWeight: '600',
    color: '#333',
  },
  badge: {
    padding: '4px 12px',
    borderRadius: '9999px',
    fontSize: '0.875rem',
    fontWeight: '600',
  },
  answerBox: {
    backgroundColor: '#f8fafc',
    padding: '16px',
    borderRadius: '6px',
    marginBottom: '16px',
  },
  answerText: {
    whiteSpace: 'pre-wrap',
    fontFamily: 'inherit',
    fontSize: '0.95rem',
    lineHeight: '1.6',
    margin: 0,
  },
  details: {
    borderTop: '1px solid #e5e7eb',
    paddingTop: '16px',
  },
  summary: {
    cursor: 'pointer',
    fontWeight: '600',
    color: '#2563eb',
    padding: '8px 0',
  },
  contextContainer: {
    marginTop: '12px',
  },
  contextPre: {
    backgroundColor: '#f1f5f9',
    padding: '12px',
    borderRadius: '6px',
    overflowX: 'auto',
    fontSize: '0.85rem',
    whiteSpace: 'pre-wrap',
  },
  staleSection: {
    marginTop: '16px',
  },
  staleItem: {
    color: '#ea580c',
    fontFamily: 'monospace',
    fontSize: '0.85rem',
  },
  missingSection: {
    marginTop: '16px',
  },
  missingItem: {
    color: '#dc2626',
    fontFamily: 'monospace',
    fontSize: '0.85rem',
  },
};
