import Dashboard from "@/pages/Dashboard";
import ToastContainer from "@/components/Toast";
import Background from "@/theme/Background";
import { ThemeProvider } from "@/theme/ThemeContext";

export default function App() {
  return (
    <ThemeProvider>
      <Background />
      <Dashboard />
      <ToastContainer />
    </ThemeProvider>
  );
}
