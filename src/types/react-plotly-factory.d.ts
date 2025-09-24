/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "react-plotly.js/factory" {
  type Plotly = any;
  export default function createPlotlyComponent(plotly: Plotly): any;
}

