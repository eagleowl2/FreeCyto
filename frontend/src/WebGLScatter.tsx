import React from "react";
import { DeckGL } from "@deck.gl/react";
import { ScatterplotLayer } from "@deck.gl/layers";

type ScatterPoint = { x: number; y: number };

type Props = {
  points: ScatterPoint[];
  width: number;
  height: number;
  margin: number;
};

export const WebGLScatter: React.FC<Props> = ({ points, width, height, margin }) => {
  const layers = React.useMemo(
    () => [
      new ScatterplotLayer<ScatterPoint>({
        id: "events-scatter",
        data: points,
        pickable: false,
        getPosition: (p) => [p.x, p.y],
        getRadius: 2,
        radiusUnits: "pixels",
        getFillColor: [74, 222, 128, 160],
      }),
    ],
    [points],
  );

  return (
    <DeckGL
      layers={layers}
      controller={false}
      initialViewState={{ target: [0.5, 0.5, 0], zoom: 0 }}
      width={width - 2 * margin}
      height={height - 2 * margin}
      style={{
        position: "absolute",
        top: margin,
        left: margin,
      }}
    />
  );
};

