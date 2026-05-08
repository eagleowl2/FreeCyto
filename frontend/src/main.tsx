import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ExperimentProvider } from "./context/ExperimentContext";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ExperimentProvider>
      <App />
    </ExperimentProvider>
  </React.StrictMode>,
);

