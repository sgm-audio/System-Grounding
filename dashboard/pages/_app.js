import '../styles/globals.css';

// Custom App component: required entry point for global CSS in Next.js pages router
export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
