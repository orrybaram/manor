// Hero: the facade, with a slideshow of the app in a plain soft-shadowed frame.
import "./hero.css";
import { mountSlideshow } from "../slideshow/slideshow";
import { SLIDES } from "../slideshow/slides";

const slideshow = document.querySelector<HTMLElement>("[data-slideshow]");
if (slideshow) mountSlideshow(slideshow, SLIDES);
