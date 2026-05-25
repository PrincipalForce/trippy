import { render } from "solid-js/web";
import { App } from "./ui/App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");
render(() => <App />, root);
